import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { createProjectSession, queryProject } from "../src/search.js";
import {
  commitGeneratedCache,
  recoverGenerationTransaction,
  removeWithRetry,
  renameWithRetry,
  TRANSACTION_ABORT_EXIT_CODE,
  acquireGenerationLock,
  releaseGenerationLock,
} from "../src/transaction.js";

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
