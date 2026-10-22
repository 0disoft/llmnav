import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { access, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { createRuntime } from "../src/runtime.js";
import { createProjectSession, queryProject } from "../src/search.js";
import {
  commitGeneratedCache,
  recoverGenerationTransaction,
  removeWithRetry,
  renameWithRetry,
  TransactionAbortError,
  TRANSACTION_ABORT_EXIT_CODE,
  acquireGenerationLock,
  releaseGenerationLock,
  withGenerationLock,
} from "../src/transaction.js";

test("stale owner observation cannot displace a newer lock owner", { timeout: 15000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-stale-race-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".llmnav/generation.lock");
  await mkdir(path.dirname(lockPath));
  await writeFile(lockPath, JSON.stringify({ schemaVersion: 1, ownerId: "dead", pid: 999999 }));
  const observed = Promise.withResolvers(), resume = Promise.withResolvers();
  const originalRead = fs.readFile;
  let armed = true;
  const mock = context.mock.method(fs, "readFile", async (...args) => {
    const content = await originalRead(...args);
    if (armed && args[0] === lockPath) {
      armed = false;
      observed.resolve();
      await resume.promise;
    }
    return content;
  });
  syncBuiltinESMExports();
  const runtime = createRuntime({ isProcessAlive: (pid) => pid !== 999999 });
  const first = acquireGenerationLock(root, { ownerId: "first", runtime, delays: [0] });
  let lock;
  try {
    await observed.promise;
    await assert.rejects(() => acquireGenerationLock(root, { ownerId: "second", runtime, delays: [0] }), /Timed out waiting/u);
    assert.equal(JSON.parse(await originalRead(lockPath, "utf8")).ownerId, "dead");
    resume.resolve();
    lock = await first;
    assert.equal(JSON.parse(await originalRead(lockPath, "utf8")).ownerId, "first");
    await assert.rejects(() => acquireGenerationLock(root, { ownerId: "third", runtime, delays: [0] }), /Timed out waiting/u);
  } finally {
    resume.resolve();
    lock ??= await first;
    mock.mock.restore(); syncBuiltinESMExports();
    await releaseGenerationLock(lock);
  }
  assert.deepEqual(await readdir(path.dirname(lockPath)), []);
});

test("a guard disappearing during a Windows read is retried without stealing ownership", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-guard-sharing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const guardPath = path.join(root, ".llmnav/generation.lock.guard");
  await mkdir(path.dirname(guardPath));
  const originalRead = fs.readFile;
  for (const code of ["EACCES", "EBUSY", "EPERM"]) {
    await writeFile(guardPath, JSON.stringify({ schemaVersion: 1, ownerId: "departing", pid: process.pid }));
    let pendingDeletion = true;
    const mock = context.mock.method(fs, "readFile", async (...args) => {
      if (args[0] === guardPath && pendingDeletion) {
        pendingDeletion = false;
        await rm(guardPath);
        throw Object.assign(new Error("guard is pending deletion"), { code });
      }
      return originalRead(...args);
    });
    syncBuiltinESMExports();
    try {
      const lock = await acquireGenerationLock(root, { delays: [0, 0] });
      assert.equal(pendingDeletion, false);
      await releaseGenerationLock(lock);
    } finally {
      mock.mock.restore(); syncBuiltinESMExports();
    }
  }
});

test("a dead mutation guard requires explicit recovery and is never stolen", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-guard-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const control = path.join(root, ".llmnav");
  await mkdir(control);
  const guardPath = path.join(control, "generation.lock.guard");
  const owner = JSON.stringify({ schemaVersion: 1, ownerId: "dead-guard", pid: 999999 });
  await writeFile(guardPath, owner);
  await assert.rejects(() => acquireGenerationLock(root, {
    runtime: createRuntime({ isProcessAlive: () => false }), delays: [0],
  }), /mutation guard needs recovery/u);
  assert.equal(await readFile(guardPath, "utf8"), owner);
  assert.deepEqual(await readdir(control), ["generation.lock.guard"]);
});

test("default retry scheduling survives a transient failure and rejects invalid schedules", async () => {
  for (const operation of ["rename", "remove"]) {
    let attempts = 0;
    const action = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("scanner busy"), { code: "EBUSY" });
    };
    const run = (options) => operation === "rename"
      ? renameWithRetry("unused-source", "unused-target", { renameImpl: action, ...options })
      : removeWithRetry("unused-target", { rmImpl: action, ...options });
    await run({});
    assert.equal(attempts, 2);
    for (const delays of [[], [-1], [0.5], [NaN]]) {
      await assert.rejects(() => run({ delays }), /Retry delays/u);
    }
    const waits = [];
    attempts = 0;
    await run({ runtime: createRuntime({ sleep: async (ms) => { waits.push(ms); } }) });
    assert.deepEqual(waits, [8]);
  }
});

test("generation locks preserve an undefined callback rejection and still release", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-undefined-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let rejected = false;
  await withGenerationLock(root, async () => { throw undefined; }).catch((error) => {
    rejected = true;
    assert.equal(error, undefined);
  });
  assert.equal(rejected, true);
  await assert.rejects(() => access(path.join(root, ".llmnav", "generation.lock")), { code: "ENOENT" });
});

test("lock waits clamp polling to the elapsed-time deadline", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-deadline-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const held = await acquireGenerationLock(root);
  try {
    for (const timeoutMs of [0, 1, 49, 50, 51]) {
      let elapsed = 0;
      const waits = [];
      await assert.rejects(() => acquireGenerationLock(root, {
        timeoutMs,
        pollMs: 50,
        scheduler: { now: () => elapsed },
        runtime: createRuntime({ sleep: async (ms) => { waits.push(ms); elapsed += ms; } }),
      }), /Timed out/u);
      assert.equal(waits.reduce((total, ms) => total + ms, 0), timeoutMs);
      assert.ok(waits.every((ms) => ms <= 50));
    }
  } finally {
    await releaseGenerationLock(held);
  }
});

test("a failed owner write leaves no authoritative lock or candidate", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-write-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => acquireGenerationLock(root, {
    openImpl: async (...args) => {
      const handle = await open(...args);
      return {
        writeFile: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
        close: () => handle.close(),
      };
    },
  }), /disk full/u);
  assert.deepEqual(await readdir(path.join(root, ".llmnav")), []);
  await releaseGenerationLock(await acquireGenerationLock(root));
});

test("owner preparation does not publish a partial lock", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-publication-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const prepared = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const pending = acquireGenerationLock(root, {
    openImpl: async (...args) => {
      const handle = await open(...args);
      return {
        writeFile: async (content) => {
          prepared.resolve();
          await resume.promise;
          return handle.writeFile(content);
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  });
  await prepared.promise;
  try {
    const other = await acquireGenerationLock(root, { delays: [0] });
    await releaseGenerationLock(other);
  } finally {
    resume.resolve();
    await releaseGenerationLock(await pending);
  }
});

test("unsupported lock publication explains hard-link requirements and cleans its candidate", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-capability-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const code of ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]) {
    const cause = Object.assign(new Error("hard link unavailable"), { code });
    await assert.rejects(() => acquireGenerationLock(root, {
      linkImpl: async () => { throw cause; },
    }), (error) => {
      assert.equal(error.cause, cause);
      assert.match(error.message, /filesystem must support hard links/u);
      assert.ok(error.message.includes(code));
      return true;
    });
    assert.deepEqual(await readdir(path.join(root, ".llmnav")), []);
  }
  const ioError = Object.assign(new Error("I/O failure"), { code: "EIO" });
  await assert.rejects(() => acquireGenerationLock(root, {
    linkImpl: async () => { throw ioError; },
  }), (error) => error === ioError);
  assert.deepEqual(await readdir(path.join(root, ".llmnav")), []);
  await releaseGenerationLock(await acquireGenerationLock(root));
});

test("an unidentifiable legacy lock reports repair guidance without stealing it", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-legacy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"));
  const lockPath = path.join(root, ".llmnav", "generation.lock");
  await writeFile(lockPath, "");
  await assert.rejects(() => acquireGenerationLock(root, { delays: [0] }), /no valid owner record/u);
  assert.equal(await readFile(lockPath, "utf8"), "");
});

test("a session holds its read lock through the registry snapshot", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-reader-snapshot-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const sourcePath = path.join(root, "src", "reserve.ts");
  const before = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, before.replace("Reserve credits", "Atomically reserve credits"));
  const originalRead = fs.readFile;
  const reached = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let pause = true;
  const mock = context.mock.method(fs, "readFile", async (file, ...args) => {
    if (pause && String(file) === path.join(root, ".llmnav", "ids.jsonl")) {
      pause = false;
      reached.resolve();
      await resume.promise;
    }
    return originalRead(file, ...args);
  });
  syncBuiltinESMExports();
  const reading = createProjectSession(root);
  try {
    await reached.promise;
    await assert.rejects(() => acquireGenerationLock(root, { delays: [0] }), /Timed out/u);
  } finally {
    resume.resolve();
    await reading;
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  const session = await reading;
  assert.equal(session.show("billing.credit.reserve").card.role, "Reserve credits before a generation job starts.");
  assert.equal((await generateProject(root)).ok, true);
  await session.refresh();
  assert.match(session.show("billing.credit.reserve").card.role, /^Atomically/u);
});

async function createProject(root) {
  await writeFile(path.join(root, "package.json"), '{"name":"transaction-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "reserve.ts"),
    `/* llmnav/1 symbol\nid=billing.credit.reserve\nrole=Reserve credits before a generation job starts.\nsearch=credit hold|reserve credits\nstability=contract\n*/\nexport function reserveCredits() { return 1; }\n`,
  );
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
}


test("an injected commit failure rolls back to the byte-identical previous cache", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-throw-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const before = await readFile(indexPath, "utf8");
  const sourcePath = path.join(root, "src", "reserve.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("Reserve credits", "Atomically reserve credits"));

  await assert.rejects(
    () => generateProject(root, { failpoint: "throw:after-cache-moved" }),
    /Injected generation failure/u,
  );
  assert.equal(await readFile(indexPath, "utf8"), before);
  const [result] = await queryProject(root, "reserve credits");
  assert.equal(result.id, "billing.credit.reserve");
});


test("an interrupted directory swap is recovered before the next query", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-abort-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const before = await readFile(indexPath, "utf8");
  const sourcePath = path.join(root, "src", "reserve.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("generation job", "remote generation job"));

  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/llmnav.js", import.meta.url)), "generate", "--root", root],
    {
      encoding: "utf8",
      env: { ...process.env, LLMNAV_TEST_FAILPOINT: "abort:after-cache-moved" },
    },
  );
  assert.equal(child.status, TRANSACTION_ABORT_EXIT_CODE, child.stderr);

  const [result] = await queryProject(root, "reserve credits");
  assert.equal(result.id, "billing.credit.reserve");
  assert.equal(await readFile(indexPath, "utf8"), before);
  await assert.rejects(() => readFile(path.join(root, ".llmnav", "generation-transaction.json"), "utf8"), /ENOENT/u);
});


test("Windows-style transient rename errors are retried without changing the destination contract", async () => {
  let attempts = 0;
  const calls = [];
  await renameWithRetry("old-cache", "backup-cache", {
    delays: [0, 0, 0],
    sleepImpl: async () => {},
    renameImpl: async (source, destination) => {
      attempts += 1;
      calls.push([source, destination]);
      if (attempts < 3) {
        const error = new Error("locked by scanner");
        error.code = attempts === 1 ? "EPERM" : "EBUSY";
        throw error;
      }
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(calls, [
    ["old-cache", "backup-cache"],
    ["old-cache", "backup-cache"],
    ["old-cache", "backup-cache"],
  ]);
});

test("a failure before the transaction journal leaves the previous cache usable and removes staging", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-stage-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const before = await readFile(indexPath, "utf8");
  const sourcePath = path.join(root, "src", "reserve.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("generation job", "queued generation job"));

  await assert.rejects(
    () => generateProject(root, { failpoint: "throw:after-write:index.json" }),
    /Injected generation failure/u,
  );
  assert.equal(await readFile(indexPath, "utf8"), before);
  await assert.rejects(() => readFile(path.join(root, ".llmnav", "generation-transaction.json"), "utf8"), /ENOENT/u);
  const [result] = await queryProject(root, "reserve credits");
  assert.equal(result.id, "billing.credit.reserve");
});

test("an interruption after installing an uncommitted cache restores the previous cache", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-installed-abort-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const before = await readFile(indexPath, "utf8");
  const sourcePath = path.join(root, "src", "reserve.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("generation job", "scheduled generation job"));

  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/llmnav.js", import.meta.url)), "generate", "--root", root],
    {
      encoding: "utf8",
      env: { ...process.env, LLMNAV_TEST_FAILPOINT: "abort:after-new-installed" },
    },
  );
  assert.equal(child.status, TRANSACTION_ABORT_EXIT_CODE, child.stderr);
  assert.notEqual(await readFile(indexPath, "utf8"), before);

  const [result] = await queryProject(root, "reserve credits");
  assert.equal(result.id, "billing.credit.reserve");
  assert.equal(await readFile(indexPath, "utf8"), before);
});

test("all Windows transient rename codes are retried", async () => {
  for (const code of ["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]) {
    let attempts = 0;
    await renameWithRetry("source", "destination", {
      delays: [0, 0],
      sleepImpl: async () => {},
      renameImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error(code);
          error.code = code;
          throw error;
        }
      },
    });
    assert.equal(attempts, 2, code);
  }
});


test("all Windows transient removal codes are retried", async () => {
  for (const code of ["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]) {
    let attempts = 0;
    await removeWithRetry("locked-cache", {
      delays: [0, 0],
      sleepImpl: async () => {},
      rmImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error(code);
          error.code = code;
          throw error;
        }
      },
    });
    assert.equal(attempts, 2, code);
  }
});

test("recovery rejects journal paths outside the owning transaction directory", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-journal-path-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav", ".transactions", "tx"), { recursive: true });
  await mkdir(path.join(root, "victim"));
  const sentinelPath = path.join(root, "victim", "sentinel.txt");
  await writeFile(sentinelPath, "must-stay\n");
  await writeFile(
    path.join(root, ".llmnav", "generation-transaction.json"),
    JSON.stringify({
      schemaVersion: 1,
      cacheDirectory: ".llmnav/cache",
      transactionDirectory: ".llmnav/.transactions/tx",
      stageDirectory: ".llmnav/.transactions/tx/stage",
      backupDirectory: "victim",
      hadExistingCache: true,
      phase: "old-moved",
    }),
  );

  await assert.rejects(
    () => recoverGenerationTransaction(root, { cacheDirectory: ".llmnav/cache" }),
    /backup directory does not belong/u,
  );
  assert.equal(await readFile(sentinelPath, "utf8"), "must-stay\n");
});

test("committed recovery prefers cache, then stage, then backup before cleaning the journal", async (context) => {
  for (const [present, action, selected] of [
    [["cache", "stage", "backup"], "finalized-committed-cache", "cache"],
    [["stage", "backup"], "installed-committed-stage", "stage"],
    [["backup"], "restored-backup-after-missing-commit", "backup"],
    [[], "cleanup", null],
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-committed-recovery-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const transactionDirectory = ".llmnav/.transactions/tx";
    await mkdir(path.join(root, transactionDirectory), { recursive: true });
    const paths = { cache: ".llmnav/cache", stage: `${transactionDirectory}/stage`, backup: `${transactionDirectory}/backup` };
    for (const name of present) {
      await mkdir(path.join(root, paths[name]), { recursive: true });
      await writeFile(path.join(root, paths[name], "sentinel"), name);
    }
    await writeFile(path.join(root, ".llmnav/generation-transaction.json"), JSON.stringify({
      schemaVersion: 1,
      cacheDirectory: paths.cache,
      transactionDirectory,
      stageDirectory: paths.stage,
      backupDirectory: paths.backup,
      hadExistingCache: true,
      phase: "committed",
    }));
    assert.deepEqual(await recoverGenerationTransaction(root, { cacheDirectory: paths.cache }), { recovered: true, action });
    if (selected) assert.equal(await readFile(path.join(root, paths.cache, "sentinel"), "utf8"), selected);
    else await assert.rejects(() => access(path.join(root, paths.cache)), { code: "ENOENT" });
    await assert.rejects(() => access(path.join(root, transactionDirectory)), { code: "ENOENT" });
    await assert.rejects(() => access(path.join(root, ".llmnav/generation-transaction.json")), { code: "ENOENT" });
  }
});

test("staging rejects artifact paths that normalize outside the cache", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-artifact-traversal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  const artifacts = new Map([
    [".llmnav/cache/manifest.json", '{"files":{}}\n'],
    [".llmnav/cache/nested/../../outside.txt", "escape\n"],
  ]);
  await assert.rejects(
    () => commitGeneratedCache(root, ".llmnav/cache", artifacts),
    /parent-directory traversal/u,
  );
  await assert.rejects(() => readFile(path.join(root, ".llmnav", "outside.txt"), "utf8"), /ENOENT/u);
});

test("staging rejects a transaction directory junction that escapes the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-link-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-link-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  await symlink(external, path.join(root, ".llmnav", ".transactions"), "junction");
  const artifacts = new Map([[".llmnav/cache/manifest.json", '{"files":{}}\n']]);

  await assert.rejects(
    () => commitGeneratedCache(root, ".llmnav/cache", artifacts),
    /traverses symbolic link/u,
  );
  assert.deepEqual(await (await import("node:fs/promises")).readdir(external), []);
});

test("a query waits for the active generator instead of recovering its journal", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-reader-lock-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const sourcePath = path.join(root, "src", "reserve.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("generation job", "locked generation job"));

  let releaseWriter;
  const writerPaused = new Promise((resolve) => {
    releaseWriter = resolve;
  });
  let reachedMoved;
  const moved = new Promise((resolve) => {
    reachedMoved = resolve;
  });
  const generation = generateProject(root, {
    onTransactionPhase: async (phase) => {
      if (phase === "after-cache-moved") {
        reachedMoved();
        await writerPaused;
      }
    },
  });
  await moved;
  let querySettled = false;
  const query = queryProject(root, "reserve credits").finally(() => {
    querySettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(querySettled, false);
  releaseWriter();
  await generation;
  const [result] = await query;
  assert.equal(result.id, "billing.credit.reserve");
});

test("concurrent generators serialize complete source-to-cache transactions", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-writer-lock-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const sourcePath = path.join(root, "src", "reserve.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("generation job", "serialized generation job"));

  let unblock;
  const blocked = new Promise((resolve) => {
    unblock = resolve;
  });
  let firstReachedStage;
  const staged = new Promise((resolve) => {
    firstReachedStage = resolve;
  });
  const first = generateProject(root, {
    onTransactionPhase: async (phase) => {
      if (phase === "after-stage") {
        firstReachedStage();
        await blocked;
      }
    },
  });
  await staged;
  let secondSettled = false;
  const second = generateProject(root).finally(() => {
    secondSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(secondSettled, false);
  unblock();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.transaction.skipped, true);
});

test("cache, registry, and stable order roll back as one generation state", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-control-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const registryPath = path.join(root, ".llmnav", "ids.jsonl");
  const orderPath = path.join(root, ".llmnav", "order.lock");
  const before = {
    index: await readFile(indexPath, "utf8"),
    registry: await readFile(registryPath, "utf8"),
    order: await readFile(orderPath, "utf8"),
  };
  await writeFile(
    path.join(root, "src", "capture.ts"),
    `/* llmnav/1 symbol\nid=billing.credit.capture\nrole=Capture a reserved credit balance after delivery.\nsearch=capture credits|reserved balance\nstability=contract\n*/\nexport function captureCredits() { return 1; }\n`,
  );

  await assert.rejects(
    () => generateProject(root, { failpoint: "throw:after-new-installed" }),
    /Injected generation failure/u,
  );
  assert.equal(await readFile(indexPath, "utf8"), before.index);
  assert.equal(await readFile(registryPath, "utf8"), before.registry);
  assert.equal(await readFile(orderPath, "utf8"), before.order);
});

test("a transient lock release failure is retried instead of stranding the lock", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-release-retry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const originalRename = fs.rename;
  let remaining = 1;
  const mock = context.mock.method(fs, "rename", async (...args) => {
    if (remaining > 0 && String(args[1]).includes(".release-")) {
      remaining -= 1;
      throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
    }
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await withGenerationLock(root, () => "completed"), "completed");
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(remaining, 0);
  await assert.rejects(() => access(path.join(root, ".llmnav", "generation.lock")), { code: "ENOENT" });
});

test("a persistent release failure keeps the callback error and force-drops a self-owned lock", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-release-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const originalRename = fs.rename;
  const mock = context.mock.method(fs, "rename", async (...args) => {
    if (String(args[1]).includes(".release-")) {
      throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
    }
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => withGenerationLock(root, () => { throw new Error("callback exploded"); }),
      { message: "callback exploded" },
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(() => access(path.join(root, ".llmnav", "generation.lock")), { code: "ENOENT" });
  const lock = await acquireGenerationLock(root, { delays: [0] });
  await releaseGenerationLock(lock);
});

test("an unreleasable lock is reported together with the callback error", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-release-stuck-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".llmnav", "generation.lock");
  const originalRename = fs.rename;
  const originalRm = fs.rm;
  const renameMock = context.mock.method(fs, "rename", async (...args) => {
    if (String(args[1]).includes(".release-")) {
      throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
    }
    return originalRename(...args);
  });
  const rmMock = context.mock.method(fs, "rm", async (target, options) => {
    if (target === lockPath) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    return originalRm(target, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => withGenerationLock(root, () => { throw new Error("callback exploded"); }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0].message, "callback exploded");
        assert.equal(error.errors[1].message, "resource busy");
        return true;
      },
    );
  } finally {
    renameMock.mock.restore();
    rmMock.mock.restore();
    syncBuiltinESMExports();
  }
  await access(lockPath);
});

test("lock options reject values that cannot produce a valid wait schedule", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-options-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => acquireGenerationLock(root, { pollMs: 0 }), /pollMs must be an integer >= 1: 0/u);
  await assert.rejects(() => acquireGenerationLock(root, { pollMs: 1.5 }), /pollMs must be an integer >= 1: 1.5/u);
  await assert.rejects(() => acquireGenerationLock(root, { timeoutMs: -1 }), /timeoutMs must be an integer >= 0: -1/u);
  await assert.rejects(() => acquireGenerationLock(root, { delays: [] }), /delays must be a non-empty array/u);
  await assert.rejects(() => acquireGenerationLock(root, { delays: [0, -5] }), /delays must be a non-empty array/u);
  await releaseGenerationLock(await acquireGenerationLock(root));
});

test("an unreadable lock owner record fails immediately instead of timing out", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-corrupt-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  const lockPath = path.join(root, ".llmnav", "generation.lock");
  await writeFile(lockPath, "{ not json");
  const started = Date.now();
  await assert.rejects(
    () => acquireGenerationLock(root, { timeoutMs: 30_000, pollMs: 50 }),
    /has no valid owner record/u,
  );
  assert.ok(Date.now() - started < 1000, "a damaged lock must not burn the full lock timeout");
  assert.equal(await readFile(lockPath, "utf8"), "{ not json");

  await writeFile(lockPath, JSON.stringify({ schemaVersion: 1, ownerId: "foreign", pid: 0 }));
  await assert.rejects(() => acquireGenerationLock(root, { timeoutMs: 30_000 }), /has no valid owner record/u);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, 0);
});

test("an injected runtime owns lock identity, liveness, and recovery decisions", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = createRuntime({ pid: 4242, now: () => 1000, randomHex: () => "abcdef" });
  const lock = await acquireGenerationLock(root, { runtime });
  assert.equal(lock.ownerId, "4242-rs-abcdef");
  assert.equal(lock.runtime, runtime);
  assert.deepEqual(
    JSON.parse(await readFile(lock.lockPath, "utf8")),
    { schemaVersion: 1, ownerId: "4242-rs-abcdef", pid: 4242 },
  );

  const foreignPath = path.join(root, ".llmnav", "generation.lock");
  await releaseGenerationLock(lock);
  await writeFile(foreignPath, JSON.stringify({ schemaVersion: 1, ownerId: "stale-owner", pid: 4243 }));

  await assert.rejects(
    () => acquireGenerationLock(root, { runtime: createRuntime({ isProcessAlive: () => true }), delays: [0] }),
    /Timed out waiting for the LLMNav generation lock/u,
  );
  const recovered = await acquireGenerationLock(root, {
    runtime: createRuntime({ isProcessAlive: () => false }),
    delays: [0],
  });
  assert.equal(JSON.parse(await readFile(foreignPath, "utf8")).pid, process.pid);
  await releaseGenerationLock(recovered);
});

test("an abort failpoint throws a recoverable abort error instead of exiting", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-transaction-abort-error-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const before = await readFile(indexPath, "utf8");
  const sourcePath = path.join(root, "src", "reserve.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("generation job", "in-process generation job"));

  await assert.rejects(
    () => generateProject(root, { failpoint: "abort:after-cache-moved" }),
    (error) => {
      assert.ok(error instanceof TransactionAbortError);
      assert.equal(error.code, "LLMNAV_ABORTED");
      assert.equal(error.exitCode, TRANSACTION_ABORT_EXIT_CODE);
      assert.equal(error.phase, "after-cache-moved");
      return true;
    },
  );
  const journalPath = path.join(root, ".llmnav", "generation-transaction.json");
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "old-moved");

  const recovery = await recoverGenerationTransaction(root, { cacheDirectory: ".llmnav/cache" });
  assert.equal(recovery.recovered, true);
  assert.equal(await readFile(indexPath, "utf8"), before);
  await assert.rejects(() => readFile(journalPath, "utf8"), /ENOENT/u);
  const [result] = await queryProject(root, "reserve credits");
  assert.equal(result.id, "billing.credit.reserve");
});

test("waiting for the generation lock stays cancellable", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-lock-abort-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const holder = await acquireGenerationLock(root, { ownerId: "holder" });

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    acquireGenerationLock(root, { ownerId: "waiter", delays: [0, 0, 0], signal: cancelled.signal }),
    (error) => {
      assert.equal(error.name, "AbortError");
      return true;
    },
  );

  const late = new AbortController();
  const timer = setTimeout(() => late.abort(), 5);
  try {
    await assert.rejects(
      acquireGenerationLock(root, { ownerId: "waiter", delays: [0, 20, 20, 20, 20, 20], signal: late.signal }),
      (error) => {
        assert.equal(error.name, "AbortError");
        return true;
      },
    );
  } finally {
    clearTimeout(timer);
  }

  const record = JSON.parse(await readFile(path.join(root, ".llmnav", "generation.lock"), "utf8"));
  assert.equal(record.ownerId, "holder");
  await releaseGenerationLock(holder);
});
