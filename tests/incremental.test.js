import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateProject } from "../src/generator.js";
import { SOURCE_INDEXER_VERSION } from "../src/incremental.js";
import { changeSyntheticCard, createSyntheticProject } from "./helpers/synthetic.js";


test("file and card indexes update incrementally without changing deterministic output", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-incremental-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createSyntheticProject(root, { fileCount: 80, cardsPerFile: 5 });

  const first = await generateProject(root);
  assert.equal(first.ok, true);
  assert.equal(first.incremental.files.parsedFiles, fixture.fileCount);
  assert.equal(first.incremental.cards.indexedCards, fixture.cardCount);
  assert.equal(first.incremental.graph.rebuiltPartitions, fixture.cardCount);

  const noop = await generateProject(root);
  assert.equal(noop.ok, true);
  assert.equal(noop.changedFiles.length, 0);
  assert.equal(noop.incremental.files.parsedFiles, 0);
  assert.equal(noop.incremental.files.reusedFilesByStat, fixture.fileCount);
  assert.equal(noop.incremental.cards.indexedCards, 0);
  assert.equal(noop.incremental.graph.reusedPartitions, fixture.cardCount);
  assert.equal(noop.incremental.graph.rebuiltPartitions, 0);
  assert.equal(noop.transaction.skipped, true);

  const touchedPath = path.join(root, "src", "fixture-000017.ts");
  const touchedTime = new Date(Date.now() + 10_000);
  await utimes(touchedPath, touchedTime, touchedTime);
  const hashReuse = await generateProject(root);
  assert.equal(hashReuse.ok, true);
  assert.equal(hashReuse.incremental.files.parsedFiles, 0);
  assert.equal(hashReuse.incremental.files.reusedFilesByHash, 1);
  assert.equal(hashReuse.incremental.files.reusedFilesByStat, fixture.fileCount - 1);
  assert.equal(hashReuse.incremental.cards.indexedCards, 0);
  assert.equal(hashReuse.incremental.graph.reusedPartitions, fixture.cardCount);
  assert.equal(hashReuse.transaction.skipped, true);

  const changed = await changeSyntheticCard(root, 17, 2);
  const incremental = await generateProject(root);
  assert.equal(incremental.ok, true);
  assert.equal(incremental.incremental.files.parsedFiles, 1);
  assert.equal(incremental.incremental.files.reusedFiles, fixture.fileCount - 1);
  assert.equal(incremental.incremental.cards.indexedCards, 1);
  assert.equal(incremental.incremental.cards.reusedCards, fixture.cardCount - 1);
  assert.ok(incremental.changedCards.some((item) => item.id === changed.id && item.dimensions.includes("semantic")));
  assert.ok(incremental.affectedCatalogs.some((item) => item.kind === "module"));

  const incrementalIndex = await readFile(path.join(root, ".llmnav", "cache", "index.json"), "utf8");
  const incrementalSearch = await readFile(path.join(root, ".llmnav", "cache", "search-index.json"), "utf8");
  const incrementalGraph = await readFile(path.join(root, ".llmnav", "cache", "graph.json"), "utf8");
  const incrementalGraphState = await readFile(path.join(root, ".llmnav", "cache", "graph-state.json"), "utf8");
  const fullCheck = await generateProject(root, { incremental: false, check: true });
  assert.equal(fullCheck.ok, true, fullCheck.changedFiles.join(", "));
  assert.equal(await readFile(path.join(root, ".llmnav", "cache", "index.json"), "utf8"), incrementalIndex);
  assert.equal(await readFile(path.join(root, ".llmnav", "cache", "search-index.json"), "utf8"), incrementalSearch);
  assert.equal(fullCheck.artifacts.get(".llmnav/cache/graph.json"), incrementalGraph);
  assert.equal(fullCheck.artifacts.get(".llmnav/cache/graph-state.json"), incrementalGraphState);
});

test("incremental generation discards file state from an older source indexer", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-incremental-version-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createSyntheticProject(root, { fileCount: 4, cardsPerFile: 2 });

  const first = await generateProject(root);
  assert.equal(first.ok, true);

  const statePath = path.join(root, ".llmnav", "cache", "file-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.indexerVersion = SOURCE_INDEXER_VERSION - 1;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const rebuilt = await generateProject(root);
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.incremental.files.parsedFiles, fixture.fileCount);
  assert.equal(rebuilt.incremental.files.reusedFiles, 0);
  assert.equal(rebuilt.incremental.files.cardsParsed, fixture.cardCount);

  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.indexerVersion, SOURCE_INDEXER_VERSION);
  const fullCheck = await generateProject(root, { incremental: false, check: true });
  assert.equal(fullCheck.ok, true, fullCheck.changedFiles.join(", "));
  assert.equal(fullCheck.index.sourceHash, rebuilt.index.sourceHash);
});
