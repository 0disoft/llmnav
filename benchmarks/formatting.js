import { performance } from "node:perf_hooks";
import { canonicalizeSource } from "../src/parser.js";
import { sha256 } from "../src/util.js";

// Run with node --expose-gc benchmarks/formatting.js in a fresh process.
const blocks = 2000;
const padding = "//" + "x".repeat(1024) + "\n";
const source = Array.from({ length: blocks }, (_, index) => padding +
  "/* llmnav/1 module\nrole=Own one stable fixture boundary.\nid=fixture.card." + index +
  "\nstability=architecture\n*/\n").join("");
Buffer.byteLength(source);
global.gc?.();
const startHeap = process.memoryUsage().heapUsed;
const start = performance.now();
const result = canonicalizeSource(source, "fixture.js");
const elapsedMs = performance.now() - start;
const heapDeltaBytes = process.memoryUsage().heapUsed - startHeap;
console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  blocks,
  sourceBytes: Buffer.byteLength(source),
  outputBytes: Buffer.byteLength(result.source),
  changed: result.changed,
  errors: result.errors.length,
  outputHash: sha256(result.source),
  elapsedMs,
  heapDeltaBytes,
}));
