import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "../src/concurrency.js";
import { initializeProject } from "../src/initializer.js";
import { scanProject } from "../src/project.js";

test("bounded maps keep input order and never exceed the limit", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [10, 2, 8, 4, 6]);
  assert.equal(peak <= 2, true);
  assert.deepEqual(await mapWithConcurrency([], 4, async () => "unused"), []);
  assert.equal(DEFAULT_IO_CONCURRENCY, 8);
});

test("bounded maps reject unusable limits and workers", async () => {
  await assert.rejects(() => mapWithConcurrency([1], 0, async () => {}), /positive integer/u);
  await assert.rejects(() => mapWithConcurrency([1], 1.5, async () => {}), /positive integer/u);
  await assert.rejects(() => mapWithConcurrency([1], 2, null), /must be a function/u);
});

test("bounded maps report the lowest failing index", async () => {
  const failure = await mapWithConcurrency([1, 2, 3], 3, async (value) => {
    if (value === 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error("first-index");
    }
    if (value === 2) throw new Error("second-index");
    return value;
  }).catch((error) => error);
  assert.equal(failure.message, "first-index");
});

test("bounded maps stop pulling work after an abort", async () => {
  const controller = new AbortController();
  const seen = [];
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3, 4], 1, async (value) => {
      seen.push(value);
      if (value === 2) controller.abort();
      return value;
    }, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.deepEqual(seen, [1, 2]);
});

test("scans the same project regardless of io concurrency", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-concurrency-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "concurrency-fixture", type: "module" }, null, 2)}\n`);
  for (let index = 0; index < 12; index += 1) {
    const directory = index % 3 === 0 ? path.join(root, "src", "nested") : path.join(root, "src");
    await writeFile(path.join(directory, `module-${index}.js`), `export function feature${index}() { return ${index}; }\n`);
  }
  await initializeProject(root, { agents: ["none"] });

  const serial = await scanProject(root, { ioConcurrency: 1 });
  const parallel = await scanProject(root, { ioConcurrency: 4 });
  assert.deepEqual(
    parallel.fileRecords.map((record) => [record.relativePath, record.contentHash]),
    serial.fileRecords.map((record) => [record.relativePath, record.contentHash]),
  );
  assert.deepEqual(parallel.records.map((record) => record.card.id), serial.records.map((record) => record.card.id));
  await assert.rejects(() => scanProject(root, { ioConcurrency: 0 }), /positive integer/u);
});
