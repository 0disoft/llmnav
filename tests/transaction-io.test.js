import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitGeneratedCache, recoverGenerationTransaction, TransactionAbortError } from "../src/transaction.js";
import { sha256 } from "../src/util.js";

function artifacts(payload = "value", count = 24) {
  const entries = new Map([[".llmnav/cache/index.json", '{"schemaVersion":1,"cards":[]}\n']]);
  for (let index = 0; index < count; index++) entries.set(`.llmnav/cache/part-${index}.txt`, payload);
  const files = Object.fromEntries([...entries].map(([file, content]) => [file, sha256(content)]));
  entries.set(".llmnav/cache/manifest.json", JSON.stringify({ files }));
  return entries;
}

test("first-generation recovery keeps the cache and both control artifacts in the same generation", async context => {
  for (const hadControls of [false, true]) {
    for (const phase of ["after-new-installed", "after-cache-moved", "after-journal"]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-first-controls-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(path.join(root, ".llmnav"));
      const controls = new Map([
        [".llmnav/ids.jsonl", '{"id":"fixture.new","state":"active"}\n'],
        [".llmnav/order.lock", '{"ids":["fixture.new"]}\n'],
      ]);
      if (hadControls) {
        for (const relative of controls.keys()) await writeFile(path.join(root, relative), "old generation\n");
      }
      const expected = artifacts("new generation", 0);
      await assert.rejects(() => commitGeneratedCache(root, ".llmnav/cache", expected,
        { controlArtifacts: controls, failpoint: `abort:${phase}` }), TransactionAbortError);

      const recovered = await recoverGenerationTransaction(root, { cacheDirectory: ".llmnav/cache" });
      assert.equal(recovered.recovered, true);
      for (const [relative, content] of [...expected, ...controls]) {
        assert.equal(await readFile(path.join(root, relative), "utf8"), content, `${hadControls}:${phase}:${relative}`);
      }
      assert.deepEqual(await recoverGenerationTransaction(root), { recovered: false, action: "none" });
    }
  }
});

test("first-generation recovery preserves its journal and resumes after control installation fails", async context => {
  for (const mode of ["rename-failure", "corrupt-stage"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-first-controls-retry-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const controls = new Map([
      [".llmnav/ids.jsonl", '{"id":"fixture.new","state":"active"}\n'],
      [".llmnav/order.lock", '{"ids":["fixture.new"]}\n'],
    ]);
    await assert.rejects(() => commitGeneratedCache(root, ".llmnav/cache", artifacts("new", 0),
      { controlArtifacts: controls, failpoint: "abort:after-cache-moved" }), TransactionAbortError);
    const journalPath = path.join(root, ".llmnav/generation-transaction.json");
    const journalBytes = await readFile(journalPath, "utf8");
    const journal = JSON.parse(journalBytes);
    const stagedOrder = path.join(root, journal.controlArtifacts[1].stagePath);
    const failure = Object.assign(new Error("control install failed"), { code: "EIO" });
    if (mode === "corrupt-stage") await writeFile(stagedOrder, "corrupted stage\n");
    const renameOptions = { delays: [0], renameImpl: async (source, destination) => {
      if (mode === "rename-failure" && source === stagedOrder) throw failure;
      await fs.rename(source, destination);
    } };
    await assert.rejects(() => recoverGenerationTransaction(root, { cacheDirectory: ".llmnav/cache", renameOptions }),
      error => mode === "rename-failure" ? error === failure : /Staged control artifact.*verification/u.test(error.message));
    assert.equal(await readFile(journalPath, "utf8"), journalBytes);
    assert.equal(await readFile(path.join(root, ".llmnav/ids.jsonl"), "utf8"), controls.get(".llmnav/ids.jsonl"));
    assert.equal(await readFile(stagedOrder, "utf8"), mode === "corrupt-stage" ? "corrupted stage\n" : controls.get(".llmnav/order.lock"));
    if (mode === "corrupt-stage") await writeFile(stagedOrder, controls.get(".llmnav/order.lock"));

    assert.equal((await recoverGenerationTransaction(root, { cacheDirectory: ".llmnav/cache" })).recovered, true);
    for (const [relative, content] of controls) assert.equal(await readFile(path.join(root, relative), "utf8"), content);
    await assert.rejects(() => readFile(journalPath), { code: "ENOENT" });
    assert.deepEqual(await recoverGenerationTransaction(root), { recovered: false, action: "none" });
  }
});

test("each artifact is read once per verification phase with bounded parallel I/O", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-verify-io-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const expected = artifacts(), reads = new Map();
  const original = fs.readFile;
  let active = 0, peak = 0;
  const mock = context.mock.method(fs, "readFile", async (file, ...args) => {
    const normalized = String(file).replaceAll("\\", "/");
    const tracked = normalized.includes("/stage/") || normalized.startsWith(`${root.replaceAll("\\", "/")}/.llmnav/cache/`);
    if (!tracked) return original(file, ...args);
    reads.set(normalized, (reads.get(normalized) ?? 0) + 1);
    active++; peak = Math.max(peak, active);
    try { return await original(file, ...args); } finally { active--; }
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await commitGeneratedCache(root, ".llmnav/cache", expected, { transactionId: "io-count" })).committed, true);
  } finally {
    mock.mock.restore(); syncBuiltinESMExports();
  }
  assert.equal(reads.size, expected.size * 2);
  for (const count of reads.values()) assert.equal(count, 1);
  assert.ok(peak > 1 && peak <= 8);
  assert.equal(active, 0);
});

test("installed verification rereads changed staged bytes and rolls back", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-verify-tamper-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await commitGeneratedCache(root, ".llmnav/cache", artifacts("previous", 1));
  await assert.rejects(() => commitGeneratedCache(root, ".llmnav/cache", artifacts("next", 1), {
    transactionId: "tamper",
    onPhase: async phase => {
      if (phase === "after-stage") await writeFile(path.join(root, ".llmnav/.transactions/tamper/stage/index.json"), "changed bytes");
    },
  }), /index\.json fails manifest verification/u);
  assert.equal(await readFile(path.join(root, ".llmnav/cache/part-0.txt"), "utf8"), "previous");
  await assert.rejects(() => fs.access(path.join(root, ".llmnav/generation.lock")), { code: "ENOENT" });
});

test("parallel staged verification preserves the first path's failure", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-verify-order-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const entries = artifacts("payload", 0);
  entries.set(".llmnav/cache/a.txt", "a"); entries.set(".llmnav/cache/b.txt", "b");
  const second = Promise.withResolvers(), original = fs.readFile;
  const mock = context.mock.method(fs, "readFile", async (file, ...args) => {
    const normalized = String(file).replaceAll("\\", "/");
    if (normalized.endsWith("/stage/a.txt")) { await second.promise; return "bad a"; }
    if (normalized.endsWith("/stage/b.txt")) { second.resolve(); return "bad b"; }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => commitGeneratedCache(root, ".llmnav/cache", entries), /Staged artifact .*a\.txt does not match/u);
  } finally {
    mock.mock.restore(); syncBuiltinESMExports();
  }
});
