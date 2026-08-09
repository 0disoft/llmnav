import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { queryProject } from "../src/search.js";
import {
  recoverGenerationTransaction,
  removeWithRetry,
  renameWithRetry,
  TRANSACTION_ABORT_EXIT_CODE,
} from "../src/transaction.js";

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
