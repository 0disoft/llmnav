import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanProject } from "../../src/project.js";

assert.equal(typeof global.gc, "function", "Run this isolated measurement with --expose-gc.");
const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-scan-memory-"));
assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
assert.ok(path.basename(root).startsWith("llmnav-scan-memory-"));
try {
  const fileCount = 16, linesPerFile = 200000;
  const source = " \n".repeat(linesPerFile);
  const files = new Set();
  for (let i = 0; i < fileCount; i++) {
    const file = path.join(root, `source-${String(i).padStart(2, "0")}.ts`);
    await writeFile(file, "");
    files.add(file);
  }
  let reads = 0, initialHeap = 0, retainedHeap = 0;
  const project = await scanProject(root, { ioConcurrency: 1, io: {
    readFile: async (file, encoding) => {
      if (!files.has(file)) return readFile(file, encoding);
      reads++;
      // Measure completed workers while their results are still held by the scan.
      if (reads === 1 || reads === fileCount) {
        global.gc();
        if (reads === 1) initialHeap = process.memoryUsage().heapUsed;
        else retainedHeap = process.memoryUsage().heapUsed - initialHeap;
      }
      return source;
    },
  } });
  assert.equal(reads, fileCount);
  assert.equal(project.fileRecords.length, fileCount);
  assert.equal(project.records.length, 0);
  assert.ok(project.fileRecords.every(file => file.source === source));
  console.log(JSON.stringify({ fileCount, linesPerFile, retainedHeapBytes: retainedHeap, sourceBytes: project.sourceBytes }));
} finally { await rm(root, { recursive: true, force: true }); }
