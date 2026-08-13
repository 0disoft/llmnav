import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistStatHints } from "../src/incremental.js";
import { formatProject } from "../src/formatter.js";
import { initializeProject } from "../src/initializer.js";
import { ensureActiveIds, loadRegistry } from "../src/registry.js";
import { loadSearchData } from "../src/search.js";

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
