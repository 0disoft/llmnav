import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

function run(mode) {
  const worker = fileURLToPath(new URL("./helpers/query-benchmark-worker.js", import.meta.url));
  const result = spawnSync(process.execPath, ["--expose-gc", worker, mode, "5000", "50"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}


test("large-fixture search accuracy, speed, and memory stay within regression gates", { timeout: 120000 }, () => {
  const legacy = run("legacy");
  const inverted = run("inverted");
  assert.equal(legacy.correct, legacy.queryCount);
  assert.equal(inverted.correct, inverted.queryCount);
  assert.equal(inverted.checksum, legacy.checksum);
  assert.ok(
    inverted.elapsedMs < legacy.elapsedMs,
    `inverted=${inverted.elapsedMs.toFixed(1)}ms legacy=${legacy.elapsedMs.toFixed(1)}ms`,
  );
  assert.ok(inverted.searchIndexBytes < 96 * 1024 * 1024, `search index bytes=${inverted.searchIndexBytes}`);
  assert.ok(inverted.rssBytes < 512 * 1024 * 1024, `rss bytes=${inverted.rssBytes}`);
  assert.ok(inverted.heapUsedBytes < 384 * 1024 * 1024, `heap bytes=${inverted.heapUsedBytes}`);
});
