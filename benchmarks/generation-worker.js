import { performance } from "node:perf_hooks";
import { generateProject } from "../src/generator.js";

const root = process.argv[2];
const mode = process.argv[3] ?? "incremental";
if (!root) throw new Error("generation-worker requires a project root");
if (!new Set(["incremental", "full"]).has(mode)) throw new Error(`Unknown generation mode ${mode}`);

if (global.gc) global.gc();
const before = process.memoryUsage();
const started = performance.now();
const result = await generateProject(root, { incremental: mode !== "full" });
const elapsedMs = performance.now() - started;
if (!result.ok) {
  console.error(JSON.stringify({ ok: false, diagnostics: result.diagnostics }));
  process.exit(1);
}
if (global.gc) global.gc();
const after = process.memoryUsage();
console.log(JSON.stringify({
  ok: true,
  mode,
  elapsedMs,
  changedFiles: result.changedFiles.length,
  changedCards: result.changedCards.length,
  affectedCatalogs: result.affectedCatalogs.length,
  files: result.incremental.files,
  cards: summarizeCardStats(result.incremental.cards),
  transaction: result.transaction,
  heapUsedBytes: after.heapUsed,
  rssBytes: after.rss,
  heapDeltaBytes: Math.max(0, after.heapUsed - before.heapUsed),
}));

function summarizeCardStats(stats) {
  if (!stats) return null;
  const { changedIds = [], removedIds = [], ...counts } = stats;
  return {
    ...counts,
    changedIdCount: changedIds.length,
    changedIdSample: changedIds.slice(0, 10),
    removedIdCount: removedIds.length,
    removedIdSample: removedIds.slice(0, 10),
  };
}
