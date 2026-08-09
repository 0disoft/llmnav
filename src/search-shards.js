/* llmnav/1 module
id=llmnav.index.search-shards
role=Split a compact search index into deterministic card-range artifacts without retokenizing documents.
owns=search shard schema|card range partitioning|shard manifest
excludes=query ranking|source parsing
search=search index sharding|monorepo search artifacts|card range shard
rel=workflow>llmnav.index.inverted
rel=workflow>llmnav.index.generate
stability=architecture
*/

import { searchCardSetHash } from "./inverted-index.js";
import { sha256, stableStringify } from "./util.js";

export const SEARCH_SHARD_SCHEMA_VERSION = 1;
export const SEARCH_SHARD_ENCODING = "card-range-v1";

export function buildSearchShards(index, searchIndex, shardSize) {
  if (!Number.isInteger(shardSize) || shardSize < 0) throw new Error("search shard size must be a non-negative integer");
  if (shardSize === 0 || searchIndex.cardIds.length <= shardSize) {
    return { manifest: null, shards: new Map() };
  }

  const cardsById = new Map(index.cards.map((card) => [card.id, card]));
  const shards = new Map();
  const records = [];
  for (let start = 0, ordinal = 0; start < searchIndex.cardIds.length; start += shardSize, ordinal += 1) {
    const end = Math.min(start + shardSize, searchIndex.cardIds.length);
    const cardIds = searchIndex.cardIds.slice(start, end);
    const cards = cardIds.map((id) => cardsById.get(id)).filter(Boolean);
    const tokens = [];
    const postings = [];
    for (const [tokenIndex, token] of searchIndex.tokens.entries()) {
      const selected = (searchIndex.postings[tokenIndex] ?? [])
        .filter(([cardIndex]) => cardIndex >= start && cardIndex < end)
        .map(([cardIndex, vector]) => [cardIndex - start, vector]);
      if (selected.length === 0) continue;
      tokens.push(token);
      postings.push(selected);
    }
    const shard = {
      ...searchIndex,
      cardSetHash: searchCardSetHash(cards),
      documentCount: cardIds.length,
      cardIds,
      tokens,
      documents: searchIndex.documents.slice(start, end),
      postings,
    };
    const file = `search-shards/${String(ordinal).padStart(4, "0")}.json`;
    const content = stableStringify(shard);
    shards.set(file, content);
    records.push({
      file,
      firstId: cardIds[0],
      lastId: cardIds.at(-1),
      cardCount: cardIds.length,
      cardSetHash: shard.cardSetHash,
      sha256: sha256(content),
    });
  }

  return {
    manifest: {
      schemaVersion: SEARCH_SHARD_SCHEMA_VERSION,
      encoding: SEARCH_SHARD_ENCODING,
      repositoryId: index.repositoryId,
      sourceCardSetHash: searchIndex.cardSetHash,
      shardSize,
      shardCount: records.length,
      shards: records,
    },
    shards,
  };
}
