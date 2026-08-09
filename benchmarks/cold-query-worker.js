import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { queryIndexLegacy, queryProject } from "../src/search.js";

const root = process.argv[2];
const mode = process.argv[3];
const query = process.argv[4];
const expected = process.argv[5];
if (!root || !query || !expected) throw new Error("cold-query-worker requires root, mode, query, and expected ID");
if (!new Set(["legacy", "inverted"]).has(mode)) throw new Error(`Unknown query mode ${mode}`);

const cacheRoot = path.join(root, ".llmnav", "cache");
const indexPath = path.join(cacheRoot, "index.json");
const searchPath = path.join(cacheRoot, "search-index.json");
const indexBytes = Number((await stat(indexPath)).size);
const searchIndexBytes = mode === "inverted" ? Number((await stat(searchPath)).size) : 0;

if (global.gc) global.gc();
const before = process.memoryUsage();
const started = performance.now();
let result;
if (mode === "inverted") {
  result = await queryProject(root, query, { top: 5 });
} else {
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const lexicon = JSON.parse(await readFile(path.join(root, ".llmnav", "lexicon.json"), "utf8"));
  result = queryIndexLegacy(index, query, { top: 5, lexicon });
}
const elapsedMs = performance.now() - started;
if (global.gc) global.gc();
const after = process.memoryUsage();
console.log(JSON.stringify({
  mode,
  elapsedMs,
  correct: result[0]?.id === expected,
  firstId: result[0]?.id ?? null,
  checksum: result.reduce((sum, item) => sum + item.id.length + Math.round(item.score * 1000), 0),
  resultCount: result.length,
  indexBytes,
  searchIndexBytes,
  heapUsedBytes: after.heapUsed,
  rssBytes: after.rss,
  heapDeltaBytes: Math.max(0, after.heapUsed - before.heapUsed),
}));
