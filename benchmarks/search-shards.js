import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { buildInvertedIndex, searchCardSetHash } from "../src/inverted-index.js";
import { buildSearchShards } from "../src/search-shards.js";
import { sha256, stableStringify } from "../src/util.js";
import { buildSyntheticIndex } from "../tests/helpers/synthetic.js";

// Pre-optimization reference: rescan all postings for each card range.
export function buildReferenceShards(index, searchIndex, shardSize) {
  if (shardSize === 0 || searchIndex.cardIds.length <= shardSize) return { manifest: null, shards: new Map() };
  const cardsById = new Map(index.cards.map((card) => [card.id, card]));
  const shards = new Map();
  const records = [];
  for (let start = 0, ordinal = 0; start < searchIndex.cardIds.length; start += shardSize, ordinal += 1) {
    const end = Math.min(start + shardSize, searchIndex.cardIds.length);
    const cardIds = searchIndex.cardIds.slice(start, end);
    const tokens = [];
    const postings = [];
    for (const [tokenIndex, token] of searchIndex.tokens.entries()) {
      const selected = (searchIndex.postings[tokenIndex] ?? [])
        .filter(([cardIndex]) => cardIndex >= start && cardIndex < end)
        .map(([cardIndex, vector]) => [cardIndex - start, vector]);
      if (!selected.length) continue;
      tokens.push(token);
      postings.push(selected);
    }
    const shard = {
      ...searchIndex,
      cardSetHash: searchCardSetHash(cardIds.map((id) => cardsById.get(id)).filter(Boolean)),
      documentCount: cardIds.length, cardIds, tokens,
      documents: searchIndex.documents.slice(start, end), postings,
    };
    const file = `search-shards/${String(ordinal).padStart(4, "0")}.json`;
    const content = stableStringify(shard);
    shards.set(file, content);
    records.push({ file, firstId: cardIds[0], lastId: cardIds.at(-1), cardCount: cardIds.length, cardSetHash: shard.cardSetHash, sha256: sha256(content) });
  }
  return {
    manifest: { schemaVersion: 1, encoding: "card-range-v1", repositoryId: index.repositoryId, sourceCardSetHash: searchIndex.cardSetHash, shardSize, shardCount: records.length, shards: records },
    shards,
  };
}

export function measureShardVisits(searchIndex, build) {
  let visits = 0;
  const instrumented = {
    ...searchIndex,
    postings: searchIndex.postings.map((entries) => new Proxy(entries, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key)) visits += 1;
        return Reflect.get(target, key, receiver);
      },
    })),
  };
  const result = build(instrumented);
  return { visits, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = buildSyntheticIndex(2000);
  const searchIndex = buildInvertedIndex(index).searchIndex;
  const samples = [];
  for (const shardSize of [20, 100, 500]) {
    const started = performance.now();
    const reference = buildReferenceShards(index, searchIndex, shardSize);
    const referenceMs = performance.now() - started;
    const optimizedStarted = performance.now();
    const optimized = buildSearchShards(index, searchIndex, shardSize);
    const optimizedMs = performance.now() - optimizedStarted;
    assert.deepEqual(optimized, reference);
    samples.push({ shardSize, shardCount: optimized.shards.size, referenceMs, optimizedMs, byteIdentical: true });
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, cards: index.cards.length, postings: searchIndex.postings.reduce((count, entries) => count + entries.length, 0), samples, note: "One local in-process sample per size; reference runs first. Includes serialization, excludes index construction. Not a production or memory benchmark." }, null, 2));
}
