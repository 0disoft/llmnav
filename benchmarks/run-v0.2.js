import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createSyntheticProject, changeSyntheticCard, syntheticId } from "../tests/helpers/synthetic.js";
import { compareText, sha256, stableStringify, toPosix } from "../src/util.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const generationWorker = fileURLToPath(new URL("./generation-worker.js", import.meta.url));
const queryWorker = fileURLToPath(new URL("./cold-query-worker.js", import.meta.url));
const fileCount = Number.parseInt(process.env.LLMNAV_BENCH_FILES ?? "1000", 10);
const cardsPerFile = 5;
const queryRuns = Number.parseInt(process.env.LLMNAV_BENCH_QUERY_RUNS ?? "7", 10);
const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-v02-benchmark-"));
const base = path.join(root, "base");
const incrementalRoot = path.join(root, "incremental");
const fullRoot = path.join(root, "full");

try {
  await mkdir(base, { recursive: true });
  const fixtureStarted = performance.now();
  const fixture = await createSyntheticProject(base, { fileCount, cardsPerFile });
  const fixtureCreationMs = performance.now() - fixtureStarted;

  const coldGeneration = runGeneration(base, "incremental");
  await cp(base, incrementalRoot, { recursive: true, preserveTimestamps: true });
  await cp(base, fullRoot, { recursive: true, preserveTimestamps: true });
  const copiedRootWarmup = runGeneration(incrementalRoot, "incremental");
  if (copiedRootWarmup.changedFiles !== 0) {
    throw new Error("Refreshing copied-root stat hints changed deterministic cache files.");
  }

  const changedFileIndex = Math.min(fileCount - 1, Math.max(0, Math.floor(fileCount * 0.61)));
  const changedCardOffset = 3;
  const expectedId = syntheticId(changedFileIndex * cardsPerFile + changedCardOffset);
  await changeSyntheticCard(incrementalRoot, changedFileIndex, changedCardOffset);
  await changeSyntheticCard(fullRoot, changedFileIndex, changedCardOffset);

  const incrementalGeneration = runGeneration(incrementalRoot, "incremental");
  const fullGeneration = runGeneration(fullRoot, "full");
  const noOpGeneration = runGeneration(incrementalRoot, "incremental");
  const cacheComparison = await compareCacheTrees(incrementalRoot, fullRoot);
  if (!cacheComparison.identical) {
    throw new Error(`Incremental and full cache bytes differ: ${cacheComparison.differences.join(", ")}`);
  }

  const query = `locate operation code${String(changedFileIndex * cardsPerFile + changedCardOffset).padStart(6, "0")} for shard${String(changedFileIndex * cardsPerFile + changedCardOffset).padStart(6, "0")}`;
  const querySamples = { legacy: [], inverted: [] };
  runQuery(incrementalRoot, "legacy", query, expectedId);
  runQuery(incrementalRoot, "inverted", query, expectedId);
  for (let run = 0; run < queryRuns; run += 1) {
    const modes = run % 2 === 0 ? ["legacy", "inverted"] : ["inverted", "legacy"];
    for (const mode of modes) querySamples[mode].push(runQuery(incrementalRoot, mode, query, expectedId));
  }

  for (const sample of [...querySamples.legacy, ...querySamples.inverted]) {
    if (!sample.correct) throw new Error(`${sample.mode} cold query returned ${sample.firstId}, expected ${expectedId}`);
  }
  const legacyChecksums = new Set(querySamples.legacy.map((sample) => sample.checksum));
  const invertedChecksums = new Set(querySamples.inverted.map((sample) => sample.checksum));
  if (legacyChecksums.size !== 1 || invertedChecksums.size !== 1 || [...legacyChecksums][0] !== [...invertedChecksums][0]) {
    throw new Error("Legacy and inverted cold-query result checksums differ.");
  }

  const report = {
    schemaVersion: 1,
    packageVersion: "0.2.0",
    measuredAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      filesystemCacheFlushed: false,
    },
    fixture: {
      files: fixture.fileCount,
      cardsPerFile: fixture.cardsPerFile,
      cards: fixture.cardCount,
      creationMs: fixtureCreationMs,
      changedFiles: 1,
      changedCards: 1,
    },
    generation: {
      cold: coldGeneration,
      oneFileIncremental: incrementalGeneration,
      oneFileFull: fullGeneration,
      noOpIncremental: noOpGeneration,
      incrementalVsFullSpeedup: fullGeneration.elapsedMs / incrementalGeneration.elapsedMs,
      byteIdenticalToFull: cacheComparison.identical,
      cacheBytes: cacheComparison.totalBytes,
      cacheFiles: cacheComparison.fileCount,
    },
    coldProcessQuery: {
      query,
      expectedId,
      runsPerMode: queryRuns,
      legacy: summarizeSamples(querySamples.legacy),
      inverted: summarizeSamples(querySamples.inverted),
      medianSpeedup: median(querySamples.legacy.map((sample) => sample.elapsedMs)) /
        median(querySamples.inverted.map((sample) => sample.elapsedMs)),
      exactResultChecksumMatch: true,
      note: "Each sample starts a fresh Node.js process. The operating-system filesystem cache was not flushed.",
    },
  };

  const major = process.versions.node.split(".")[0];
  const resultName = `v0.2-${process.platform}-${process.arch}-node${major}.json`;
  const resultPath = path.join(packageRoot, "benchmarks", "results", resultName);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, stableStringify(report));
  await writeFile(path.join(packageRoot, "docs", "performance-v0.2.md"), renderMarkdown(report, resultName));
  console.log(stableStringify({ resultPath: toPosix(path.relative(packageRoot, resultPath)), report }).trimEnd());
} finally {
  await rm(root, { recursive: true, force: true });
}

function runGeneration(projectRoot, mode) {
  const output = execFileSync(process.execPath, ["--expose-gc", generationWorker, projectRoot, mode], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function runQuery(projectRoot, mode, query, expectedId) {
  const output = execFileSync(process.execPath, ["--expose-gc", queryWorker, projectRoot, mode, query, expectedId], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

async function compareCacheTrees(leftRoot, rightRoot) {
  const left = await readTree(path.join(leftRoot, ".llmnav", "cache"));
  const right = await readTree(path.join(rightRoot, ".llmnav", "cache"));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort(compareText);
  const differences = paths.filter((file) => left.get(file)?.hash !== right.get(file)?.hash);
  return {
    identical: differences.length === 0,
    differences,
    fileCount: paths.length,
    totalBytes: [...left.values()].reduce((sum, item) => sum + item.bytes, 0),
  };
}

async function readTree(root) {
  const output = new Map();
  await visit(root, "");
  return output;

  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        const content = await readFile(absolute);
        output.set(relative, { hash: sha256(content), bytes: content.byteLength });
      }
    }
  }
}

function summarizeSamples(samples) {
  const elapsed = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
  const rss = samples.map((sample) => sample.rssBytes).sort((left, right) => left - right);
  const heap = samples.map((sample) => sample.heapUsedBytes).sort((left, right) => left - right);
  return {
    correct: samples.filter((sample) => sample.correct).length,
    checksum: samples[0]?.checksum ?? null,
    medianMs: median(elapsed),
    p95Ms: percentile(elapsed, 0.95),
    minMs: elapsed[0] ?? 0,
    maxMs: elapsed.at(-1) ?? 0,
    medianRssBytes: median(rss),
    medianHeapUsedBytes: median(heap),
    indexBytes: samples[0]?.indexBytes ?? 0,
    searchIndexBytes: samples[0]?.searchIndexBytes ?? 0,
  };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, value) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))];
}

function renderMarkdown(report, resultName) {
  const generation = report.generation;
  const query = report.coldProcessQuery;
  const mib = (value) => (value / (1024 * 1024)).toFixed(2);
  const ms = (value) => value.toFixed(2);
  return `# LLMNav v0.2 performance report

This report contains measured results from \`npm run benchmark:v0.2\`. It is not an estimate. The raw record is \`benchmarks/results/${resultName}\`.

## Environment

| Property | Value |
| --- | --- |
| Platform | ${report.environment.platform} ${report.environment.arch} |
| Node.js | ${report.environment.node} |
| CPU | ${report.environment.cpu} |
| Logical CPUs | ${report.environment.logicalCpuCount} |
| Fixture | ${report.fixture.files.toLocaleString("en-US")} files, ${report.fixture.cards.toLocaleString("en-US")} cards |
| Filesystem cache | Not flushed |

## Generation

| Scenario | Time | Parsed files | Reused files | Retokenized cards |
| --- | ---: | ---: | ---: | ---: |
| Cold initial generation | ${ms(generation.cold.elapsedMs)} ms | ${generation.cold.files.parsedFiles} | ${generation.cold.files.reusedFiles} | ${generation.cold.cards.indexedCards} |
| One-file incremental regeneration | ${ms(generation.oneFileIncremental.elapsedMs)} ms | ${generation.oneFileIncremental.files.parsedFiles} | ${generation.oneFileIncremental.files.reusedFiles} | ${generation.oneFileIncremental.cards.indexedCards} |
| Same change, forced full regeneration | ${ms(generation.oneFileFull.elapsedMs)} ms | ${generation.oneFileFull.files.parsedFiles} | ${generation.oneFileFull.files.reusedFiles} | ${generation.oneFileFull.cards.indexedCards} |
| No-op incremental regeneration | ${ms(generation.noOpIncremental.elapsedMs)} ms | ${generation.noOpIncremental.files.parsedFiles} | ${generation.noOpIncremental.files.reusedFiles} | ${generation.noOpIncremental.cards.indexedCards} |

The one-file incremental run was ${generation.incrementalVsFullSpeedup.toFixed(2)}× faster than the forced full run on this machine. Incremental and full generation produced byte-identical cache trees across ${generation.cacheFiles} files (${mib(generation.cacheBytes)} MiB).

## Fresh-process query

Each sample started a fresh Node.js process and included reading and parsing the required generated JSON. The operating-system filesystem cache was not flushed.

| Search path | Correct runs | Median | p95 | Median RSS | Input artifacts |
| --- | ---: | ---: | ---: | ---: | ---: |
| v0.1-compatible legacy retokenization | ${query.legacy.correct}/${query.runsPerMode} | ${ms(query.legacy.medianMs)} ms | ${ms(query.legacy.p95Ms)} ms | ${mib(query.legacy.medianRssBytes)} MiB | ${mib(query.legacy.indexBytes)} MiB index |
| v0.2 deterministic inverted index | ${query.inverted.correct}/${query.runsPerMode} | ${ms(query.inverted.medianMs)} ms | ${ms(query.inverted.p95Ms)} ms | ${mib(query.inverted.medianRssBytes)} MiB | ${mib(query.inverted.indexBytes + query.inverted.searchIndexBytes)} MiB index + search index |

The v0.2 median was ${query.medianSpeedup.toFixed(2)}× faster. Both paths returned the same result checksum, and all runs returned the expected semantic ID.

## Interpretation

The query comparison deliberately includes JSON loading. It therefore measures the cost seen by a one-shot CLI process rather than only the in-memory ranking loop. The generation comparison uses two copies of the same fixture and verifies the resulting cache bytes before reporting the timing.

The changed source file contains five cards, so the machine-readable body-hash diff reports five modified cards. Only one card changed searchable fields, and the card-level inverted index retokenized exactly that one card.
`;
}
