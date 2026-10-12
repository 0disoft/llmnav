import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializeProject } from "../src/initializer.js";
import { acquireGenerationLock, releaseGenerationLock } from "../src/transaction.js";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-init-concurrency-"));
  context.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("llmnav-init-concurrency-"));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "package.json"), '{"name":"initialization-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/work.js"), "/* llmnav/1 symbol\nid=demo.work\nrole=Complete a reviewed demo task.\nsearch=demo task|reviewed work\nstability=contract\n*/\nexport function work() {}\n");
  return root;
}

test("initialization waits for an active generation lock before changing bootstrap state", { timeout: 15000 }, async (context) => {
  const root = await fixture(context);
  assert.equal((await initializeProject(root, { agents: ["none"] })).ok, true);
  const configPath = path.join(root, ".llmnav/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.repositoryId = "retained-identity";
  await writeFile(configPath, JSON.stringify(config) + "\n");
  const before = await readFile(configPath, "utf8");
  const lock = await acquireGenerationLock(root);
  const attempted = Promise.withResolvers();
  const originalLink = fs.link;
  const mock = context.mock.method(fs, "link", async (...args) => {
    if (args[1] === lock.lockPath) attempted.resolve();
    return originalLink(...args);
  });
  syncBuiltinESMExports();
  const pending = initializeProject(root, { agents: ["all"], force: true, packageScripts: true });
  try {
    await attempted.promise;
    assert.equal(await readFile(configPath, "utf8"), before);
    await assert.rejects(() => access(path.join(root, "AGENTS.md")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts, undefined);
  } finally {
    await releaseGenerationLock(lock);
    await pending;
    mock.mock.restore(); syncBuiltinESMExports();
  }
  assert.equal((await pending).ok, true);
});

test("another initializer cannot write package scripts while the first bootstrap is paused", { timeout: 15000 }, async (context) => {
  const root = await fixture(context);
  const paused = Promise.withResolvers(), resume = Promise.withResolvers(), contending = Promise.withResolvers();
  const originalRename = fs.rename, originalLink = fs.link;
  let armed = true, watchContender = false;
  const renameMock = context.mock.method(fs, "rename", async (...args) => {
    if (armed && args[1] === path.join(root, "AGENTS.md")) {
      armed = false; paused.resolve(); await resume.promise;
    }
    return originalRename(...args);
  });
  const linkMock = context.mock.method(fs, "link", async (...args) => {
    if (watchContender && args[1] === path.join(root, ".llmnav/generation.lock")) contending.resolve();
    return originalLink(...args);
  });
  syncBuiltinESMExports();
  const first = initializeProject(root, { agents: ["agents"] });
  let second;
  try {
    await paused.promise;
    watchContender = true;
    second = initializeProject(root, { agents: ["none"], packageScripts: true });
    await contending.promise;
    assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts, undefined);
  } finally {
    resume.resolve();
    await Promise.all([first, second]);
    renameMock.mock.restore(); linkMock.mock.restore(); syncBuiltinESMExports();
  }
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts["llmnav:check"], "llmnav check");
});

test("a killed bootstrap releases its stale ownership on retry and completes the first searchable index", { timeout: 15000 }, async (context) => {
  const root = await fixture(context);
  const script = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import path from "node:path";
    const root = process.argv[1];
    const original = fs.rename;
    fs.rename = async (...args) => {
      if (args[1] === path.join(root, ".llmnav/ids.jsonl")) {
        let owner = null;
        try { owner = JSON.parse(await fs.readFile(path.join(root, ".llmnav/generation.lock"), "utf8")); } catch {}
        process.send({ ready: true, owned: owner?.pid === process.pid });
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    const { initializeProject } = await import(${JSON.stringify(new URL("../src/initializer.js", import.meta.url).href)});
    await initializeProject(root, { agents: ["agents"] });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, root], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    const ready = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(Error("Bootstrap child exited before the pause.")));
    });
    assert.equal(ready.owned, true);
  } finally {
    child.kill("SIGKILL"); await closed;
  }
  assert.equal((await initializeProject(root, { agents: ["agents"] })).ok, true);
  await assert.rejects(() => access(path.join(root, ".llmnav/generation.lock")), { code: "ENOENT" });
  const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));
  const queried = spawnSync(process.execPath, [cli, "query", "reviewed demo task", "--root", root, "--json"], { encoding: "utf8", timeout: 5000 });
  assert.equal(queried.status, 0, queried.stderr);
  assert.equal(JSON.parse(queried.stdout)[0].id, "demo.work");
});
