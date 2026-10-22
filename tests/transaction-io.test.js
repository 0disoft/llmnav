import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitGeneratedCache } from "../src/transaction.js";
import { sha256 } from "../src/util.js";

function artifacts(payload = "value", count = 24) {
  const entries = new Map([[".llmnav/cache/index.json", '{"schemaVersion":1,"cards":[]}\n']]);
  for (let index = 0; index < count; index++) entries.set(`.llmnav/cache/part-${index}.txt`, payload);
  const files = Object.fromEntries([...entries].map(([file, content]) => [file, sha256(content)]));
  entries.set(".llmnav/cache/manifest.json", JSON.stringify({ files }));
  return entries;
}

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
