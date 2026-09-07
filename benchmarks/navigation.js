import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { generateProject } from "../src/generator.js";
import { buildContext, createProjectSession, loadSearchData, queryPreparedIndex, queryProject } from "../src/search.js";
import { PACKAGE_VERSION } from "../src/spec.js";
import { approximateTokens, sha256 } from "../src/util.js";
import { createSyntheticProject, syntheticQueries } from "../tests/helpers/synthetic.js";

const scriptPath = fileURLToPath(import.meta.url);

export async function runNavigationBenchmark(options = {}) {
  const fileCount = bounded(options.fileCount ?? 100, 1, 500, "fileCount");
  const cardsPerFile = bounded(options.cardsPerFile ?? 10, 2, 20, "cardsPerFile");
  const queryCount = bounded(options.queryCount ?? 50, 1, 100, "queryCount");
  const relationsPerCard = bounded(options.relationsPerCard ?? 3, 1, 6, "relationsPerCard");
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-navigation-bench-"));
  try {
    const fixture = await createSyntheticProject(root, { fileCount, cardsPerFile, relationsPerCard });
    const generated = await generateProject(root);
    assert.equal(generated.ok, true, JSON.stringify(generated.diagnostics));
    const edges = generated.graph.edges.length;
    assert.ok(edges > 0, "the navigation benchmark must exercise a real graph");
    const started = performance.now();
    const worker = spawnSync(process.execPath, ["--expose-gc", scriptPath, "--worker", root, String(fixture.cardCount), String(queryCount)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(worker.status, 0, worker.stderr || worker.error?.message);
    return {
      schemaVersion: 1,
      packageVersion: PACKAGE_VERSION,
      fixture: { files: fileCount, cards: fixture.cardCount, relationsPerCard, edges },
      workerWallMs: performance.now() - started,
      ...JSON.parse(worker.stdout),
    };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function measureNavigation(root, cardCount, queryCount) {
  global.gc?.();
  const initialStarted = performance.now();
  const session = await createProjectSession(root);
  const initialSessionMs = performance.now() - initialStarted;
  const cases = syntheticQueries(cardCount, queryCount);
  const contextOptions = { depth: 1, maxEdges: 12, budget: 2500 };
  const firstStarted = performance.now();
  const firstResult = session.query(cases[0].query);
  const firstQueryMs = performance.now() - firstStarted;
  assert.equal(firstResult[0]?.id, cases[0].expected);
  const querySamples = [];
  const contextSamples = [];
  const resultSignatures = [];
  const contextSignatures = [];
  const work = {};
  for (const item of cases) {
    const metrics = {};
    const queryStarted = performance.now();
    const results = session.query(item.query, { top: 5, metrics });
    querySamples.push(performance.now() - queryStarted);
    assert.equal(results[0]?.id, item.expected);
    resultSignatures.push(querySignature(results));
    for (const [key, count] of Object.entries(metrics)) work[key] = (work[key] ?? 0) + count;
    const contextStarted = performance.now();
    const packed = session.context(item.expected, contextOptions);
    contextSamples.push(performance.now() - contextStarted);
    assert.equal(packed.included[0], item.expected);
    assert.ok(packed.includedEdges.length > 0 && packed.includedEdges.length <= contextOptions.maxEdges);
    assert.ok(approximateTokens(packed.text) <= contextOptions.budget);
    contextSignatures.push(sha256(packed.text));
  }
  const refreshStarted = performance.now();
  await session.refresh();
  const refreshMs = performance.now() - refreshStarted;
  assert.equal(querySignature(session.query(cases[0].query)), resultSignatures[0]);
  assert.equal(sha256(session.context(cases[0].expected, contextOptions).text), contextSignatures[0]);
  global.gc?.();
  const memory = process.memoryUsage();

  // Reference comparisons are outside the measured session loops.
  const data = await loadSearchData(root);
  for (const [index, item] of cases.entries()) {
    const reference = queryPreparedIndex(data.index, data.searchIndex, item.query, {
      top: 5, graph: data.graph, lexicon: data.lexicon,
    });
    assert.equal(querySignature(reference), resultSignatures[index]);
  }
  const directSamples = [];
  for (const [index, item] of cases.slice(0, 3).entries()) {
    const started = performance.now();
    const results = await queryProject(root, item.query);
    directSamples.push(performance.now() - started);
    assert.equal(querySignature(results), resultSignatures[index]);
  }
  const directContext = await buildContext(root, cases[0].expected, contextOptions);
  assert.equal(sha256(directContext.text), contextSignatures[0]);
  return {
    environment: {
      platform: process.platform, arch: process.arch, node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown", filesystemCacheFlushed: false,
    },
    initialSessionMs,
    firstQueryMs,
    refreshMs,
    sessionQuery: { ...summarize(querySamples), work },
    sessionContext: summarize(contextSamples),
    directQuery: summarize(directSamples),
    memory: { heapUsedBytes: memory.heapUsed, rssBytes: memory.rss },
    correctness: {
      queries: cases.length, contexts: cases.length, exactQueryMatch: true,
      boundedGraphContext: true, refreshStable: true,
      queryDigest: sha256(resultSignatures.join("\n")), contextDigest: sha256(contextSignatures.join("\n")),
    },
    note: "Session initialization starts in a fresh process after module imports. The filesystem cache is not flushed. Fixture generation and reference checks are outside session timings; refresh uses unchanged source.",
  };
}

function querySignature(results) {
  return JSON.stringify(results.map(({ id, score, reasons }) => ({ id, score, reasons })));
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function bounded(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.argv[2] === "--worker") {
    const result = await measureNavigation(process.argv[3], bounded(Number(process.argv[4]), 2, 10000, "cardCount"), bounded(Number(process.argv[5]), 1, 100, "queryCount"));
    console.log(JSON.stringify(result));
  } else {
    console.log(JSON.stringify(await runNavigationBenchmark(), null, 2));
  }
}
