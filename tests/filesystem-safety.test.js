import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistStatHints } from "../src/incremental.js";
import { formatProject } from "../src/formatter.js";
import { initializeProject } from "../src/initializer.js";
import { ensureActiveIds, loadRegistry } from "../src/registry.js";
import { loadSearchData } from "../src/search.js";
import { atomicWrite, writeFileAndClose } from "../src/util.js";
import { createRuntime } from "../src/runtime.js";
import { toErrorPayload } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import { createMcpServer } from "../src/mcp.js";
import { DEFAULT_CONFIG } from "../src/spec.js";

test("configuration rejects a control-directory link before reading or exposing outside content", async (context) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "llmnav-config-link-"));
  assert.equal(path.dirname(sandbox), path.resolve(os.tmpdir()));
  assert.ok(path.basename(sandbox).startsWith("llmnav-config-link-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, "repository"), external = path.join(sandbox, "outside");
  await mkdir(root);
  await mkdir(external);
  const target = path.join(external, "config.json");
  await writeFile(target, '{"repositoryId":"external-config"}\n');
  await symlink(external, path.join(root, ".llmnav"), process.platform === "win32" ? "junction" : "dir");
  let reads = 0;
  const io = { readFile: async (file, encoding) => { reads++; return readFile(file, encoding); } };
  await assert.rejects(() => loadConfig(root, { io }), /traverses symbolic link/u);
  assert.equal(reads, 0);
  const reason = new Error("cancel config read");
  await assert.rejects(() => loadConfig(root, { io, signal: AbortSignal.abort(reason) }), error => error === reason);
  assert.equal(reads, 0);

  const canary = "SYNTHETIC_PRIVATE_CONFIG_CANARY";
  await writeFile(target, canary);
  const server = createMcpServer({ root, session: null });
  const response = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "llmnav_discover", arguments: { task: "configuration" } } });
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /traverses symbolic link/u);
  assert.equal(JSON.stringify(response).includes(canary.slice(0, 8)), false);
  assert.equal(await readFile(target, "utf8"), canary);
});

test("configuration rejects a final file symlink without reading its target", async (context) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "llmnav-config-file-link-"));
  assert.equal(path.dirname(sandbox), path.resolve(os.tmpdir()));
  assert.ok(path.basename(sandbox).startsWith("llmnav-config-file-link-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, "repository");
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  const target = path.join(sandbox, "private.json");
  await writeFile(target, '{"repositoryId":"linked-config"}\n');
  try {
    await symlink(target, path.join(root, ".llmnav", "config.json"), "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") return context.skip("File symlinks require Windows developer mode or privilege.");
    throw error;
  }
  let reads = 0;
  await assert.rejects(() => loadConfig(root, { io: { readFile: async () => { reads++; return '{}'; } } }), /traverses symbolic link/u);
  assert.equal(reads, 0);
});

test("ordinary configuration keeps defaults, overrides and JSON parse failures", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-config-ordinary-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("llmnav-config-ordinary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual((await loadConfig(root)).config, DEFAULT_CONFIG);
  await mkdir(path.join(root, ".llmnav"));
  assert.deepEqual((await loadConfig(root)).config, DEFAULT_CONFIG);
  const configPath = path.join(root, ".llmnav", "config.json");
  await writeFile(configPath, '{"repositoryId":"normal-config"}\n');
  const loaded = await loadConfig(root);
  assert.equal(loaded.config.repositoryId, "normal-config");
  assert.deepEqual(loaded.config.generation, DEFAULT_CONFIG.generation);
  await writeFile(configPath, '{broken');
  await assert.rejects(() => loadConfig(root), SyntaxError);
});

test("write, close, and temporary cleanup failures retain every original error", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-atomic-causes-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const disk = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const close = Object.assign(new Error("close failed"), { code: "EIO" });
  const cleanup = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
  let closed = 0;
  await assert.rejects(() => atomicWrite(root, path.join(root, "target"), "next", {
    io: {
      open: async () => ({ writeFile: async () => { throw disk; }, close: async () => { closed++; throw close; } }),
      rm: async () => { throw cleanup; },
    },
  }), error => {
    assert.equal(error.errors[0].errors[0], disk);
    assert.equal(error.errors[0].errors[1], close);
    assert.equal(error.errors[1], cleanup);
    const wire = JSON.stringify(toErrorPayload(error));
    for (const code of ["ENOSPC", "EIO", "EACCES"]) assert.ok(wire.includes(code));
    return true;
  });
  assert.equal(closed, 1);
  await assert.rejects(() => writeFileAndClose({ writeFile: async () => {}, close: async () => { throw close; } }, ""), error => error === close);
  let failed = false;
  await writeFileAndClose({ writeFile: async () => { throw undefined; }, close: async () => {} }, "").catch(error => {
    failed = true; assert.equal(error, undefined);
  });
  assert.equal(failed, true);
});

test("formatting rejects concurrent edits instead of overwriting current source", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-format-conflict-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "source.js");
  const source = "/* llmnav/1 file\nrole=Own the fixture boundary.\nid=fixture.test\nstability=architecture\n*/\nexport const value = 1;\n";
  const newer = source.replace("value = 1", "value = 2");
  await writeFile(filePath, source);
  await assert.rejects(() => formatProject(root, {
    paths: ["source.js"],
    atomicWriteOptions: { beforeCommit: async () => writeFile(filePath, newer) },
  }), { code: "LLMNAV_WRITE_CONFLICT" });
  assert.equal(await readFile(filePath, "utf8"), newer);
  assert.deepEqual((await readdir(root)).filter(name => name.includes(".tmp-")), []);
  await assert.rejects(() => fs.access(path.join(root, ".llmnav/generation.lock")), { code: "ENOENT" });
  assert.deepEqual((await formatProject(root, { paths: ["source.js"] })).changedFiles, ["source.js"]);
  assert.ok((await readFile(filePath, "utf8")).includes("value = 2"));
});

test("concurrent formatters re-read source under the repository lock", { timeout: 15000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-format-serialized-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.js"), "/* llmnav/1 file\nrole=Own the fixture boundary.\nid=fixture.test\nstability=architecture\n*/\n");
  const paused = Promise.withResolvers(), resume = Promise.withResolvers(), contending = Promise.withResolvers();
  const first = formatProject(root, { paths: ["source.js"], atomicWriteOptions: {
    beforeCommit: async () => { paused.resolve(); await resume.promise; },
  } });
  await paused.promise;
  const originalLink = fs.link;
  const mock = context.mock.method(fs, "link", async (...args) => {
    if (args[1] === path.join(root, ".llmnav/generation.lock")) contending.resolve();
    return originalLink(...args);
  });
  syncBuiltinESMExports();
  const second = formatProject(root, { paths: ["source.js"] });
  try {
    await contending.promise;
  } finally {
    resume.resolve();
    await Promise.all([first, second]);
    mock.mock.restore(); syncBuiltinESMExports();
  }
  assert.deepEqual((await first).changedFiles, ["source.js"]);
  assert.deepEqual((await second).changedFiles, []);
});

test("a failed atomic write removes the partially written temporary file", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-atomic-write-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => atomicWrite(root, path.join(root, "registry.json"), "payload\n", {
    io: { open: async (...args) => {
      const handle = await open(...args);
      return {
        async writeFile(...writeArgs) {
          await handle.writeFile(...writeArgs);
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        },
        close: () => handle.close(),
      };
    } },
  }), /no space left/u);
  assert.deepEqual(await readdir(root), []);
});

test("an atomic temporary-name collision preserves the other writer's file", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-atomic-collision-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "registry.json");
  const runtime = createRuntime({ pid: 4242, randomHex: () => "collision" });
  const occupied = `${target}.tmp-4242-collision`;
  await writeFile(target, "previous");
  await writeFile(occupied, "other writer");
  await assert.rejects(() => atomicWrite(root, target, "next", { runtime }), { code: "EEXIST" });
  assert.equal(await readFile(occupied, "utf8"), "other writer");
  assert.equal(await readFile(target, "utf8"), "previous");
});

test("initialization rejects a schema directory junction outside the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-init-link-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "llmnav-init-link-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"init-link-fixture"}\n');
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  await symlink(external, path.join(root, ".llmnav", "schema"), "junction");

  await assert.rejects(() => initializeProject(root, { agents: ["none"] }), /traverses symbolic link/u);
  assert.deepEqual(await readdir(external), []);
});

test("stat hints reject a state directory junction outside the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-state-link-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "llmnav-state-link-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  await symlink(external, path.join(root, ".llmnav", "state"), "junction");

  await assert.rejects(
    () => persistStatHints(root, path.join(root, ".llmnav", "state", "stat-hints.json"), { schemaVersion: 1 }),
    /traverses symbolic link/u,
  );
  assert.deepEqual(await readdir(external), []);
});

test("search rejects a generated cache junction outside the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-search-link-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "llmnav-search-link-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"search-link-fixture"}\n');
  await writeFile(path.join(root, "source.js"), "export const value = true;\n");
  await initializeProject(root, { agents: ["none"] });
  const externalCache = path.join(external, "cache");
  await rename(path.join(root, ".llmnav", "cache"), externalCache);
  await symlink(externalCache, path.join(root, ".llmnav", "cache"), "junction");

  await assert.rejects(() => loadSearchData(root), /traverses symbolic link/u);
});

test("registry APIs reject junctions and caller-supplied paths outside the repository", async (context) => {
  const linkedRoot = await mkdtemp(path.join(os.tmpdir(), "llmnav-registry-link-root-"));
  const linkedExternal = await mkdtemp(path.join(os.tmpdir(), "llmnav-registry-link-external-"));
  const normalRoot = await mkdtemp(path.join(os.tmpdir(), "llmnav-registry-root-"));
  context.after(() => rm(linkedRoot, { recursive: true, force: true }));
  context.after(() => rm(linkedExternal, { recursive: true, force: true }));
  context.after(() => rm(normalRoot, { recursive: true, force: true }));
  await symlink(linkedExternal, path.join(linkedRoot, ".llmnav"), "junction");
  await mkdir(path.join(normalRoot, ".llmnav"), { recursive: true });

  await assert.rejects(() => loadRegistry(linkedRoot), /traverses symbolic link/u);
  await assert.rejects(
    () => ensureActiveIds(normalRoot, { registryPath: path.join(linkedExternal, "ids.jsonl"), records: [] }, ["safe.id"]),
    /does not belong to the requested project root/u,
  );
  assert.deepEqual(await readdir(linkedExternal), []);
});

test("formatter rejects a parent-directory junction swap before committing source", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-format-race-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "llmnav-format-race-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"format-race"}\n');
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "source.js"),
    "/* llmnav/1 symbol\nsearch=cache migration|format race\nid=format.race\nrole=Reject directory replacement before formatting source.\nstability=contract\n*/\nexport function source() {}\n",
  );
  await initializeProject(root, { agents: ["none"] });
  const originalDirectory = path.join(root, "src-original");

  await assert.rejects(
    () => formatProject(root, {
      atomicWriteOptions: {
        beforeCommit: async () => {
          await rename(path.join(root, "src"), originalDirectory);
          await symlink(external, path.join(root, "src"), "junction");
        },
      },
    }),
    /traverses symbolic link|parent directory changed/u,
  );
  assert.deepEqual(await readdir(external), []);
  assert.match(await readFile(path.join(originalDirectory, "source.js"), "utf8"), /search=cache migration\|format race\nid=format\.race/u);
});
