import { performance } from "node:perf_hooks";
import { buildInvertedIndex } from "../../src/inverted-index.js";
import { queryIndexLegacy, queryPreparedIndex } from "../../src/search.js";
import { buildSyntheticIndex, syntheticQueries } from "./synthetic.js";

const mode = process.argv[2];
const cardCount = Number.parseInt(process.argv[3] ?? "5000", 10);
const queryCount = Number.parseInt(process.argv[4] ?? "50", 10);
const index = buildSyntheticIndex(cardCount);
const queries = syntheticQueries(cardCount, queryCount);
const searchIndex = mode === "inverted" ? buildInvertedIndex(index).searchIndex : null;
if (global.gc) global.gc();
const before = process.memoryUsage();
const started = performance.now();
let correct = 0;
let checksum = 0;
for (const item of queries) {
  const results = mode === "inverted"
    ? queryPreparedIndex(index, searchIndex, item.query, { top: 5, lexicon: { aliases: {} } })
    : queryIndexLegacy(index, item.query, { top: 5, lexicon: { aliases: {} } });
  if (results[0]?.id === item.expected) correct += 1;
  for (const result of results) checksum += result.id.length + Math.round(result.score * 1000);
}
const elapsedMs = performance.now() - started;
if (global.gc) global.gc();
const after = process.memoryUsage();
console.log(JSON.stringify({
  mode,
  cardCount,
  queryCount: queries.length,
  correct,
  checksum,
  elapsedMs,
  heapUsedBytes: after.heapUsed,
  rssBytes: after.rss,
  heapDeltaBytes: Math.max(0, after.heapUsed - before.heapUsed),
  searchIndexBytes: searchIndex ? Buffer.byteLength(JSON.stringify(searchIndex)) : 0,
}));
