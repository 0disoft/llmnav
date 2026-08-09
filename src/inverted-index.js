/* llmnav/1 module
id=llmnav.index.inverted
role=Compile searchable card fields into a deterministic inverted index that can be updated one card at a time.
owns=posting lists|card search documents|incremental token reuse
excludes=semantic source syntax|query presentation
search=inverted index|incremental search index|posting list
rel=workflow>llmnav.search.tokenize
rel=workflow>llmnav.index.generate
stability=architecture
*/

import { compareText, sha256, stableJson, stableStringify } from "./util.js";
import { normalizeSearchText, tokenize, TOKENIZER_VERSION } from "./tokenizer.js";

export const SEARCH_INDEX_SCHEMA_VERSION = 2;
export const SEARCH_INDEX_ENCODING = "compact-v1";

export const SEARCH_FIELD_ORDER = Object.freeze([
  "id",
  "role",
  "search",
  "owns",
  "excludes",
  "invariant",
  "effect",
  "risk",
  "symbol",
  "path",
  "signature",
]);

export const SEARCH_FIELD_WEIGHTS = Object.freeze({
  id: 12,
  role: 8,
  search: 10,
  owns: 7,
  excludes: 2,
  invariant: 6,
  effect: 5,
  risk: 4,
  symbol: 5,
  path: 3,
  signature: 3,
});

export function buildInvertedIndex(index, previous = null) {
  let previousUsable = isCompatibleSearchIndex(previous, index.repositoryId);
  let postings = new Map();
  let previousDocuments = new Map();
  if (previousUsable) {
    try {
      ({ postings, documents: previousDocuments } = deserializeSearchIndex(previous));
    } catch {
      previousUsable = false;
      postings = new Map();
      previousDocuments = new Map();
    }
  }

  const documents = new Map();
  const currentById = new Map(index.cards.map((card) => [card.id, card]));
  const changedIds = [];
  const removedIds = [];
  let reusedCards = 0;
  let indexedCards = 0;

  if (previousUsable) {
    for (const id of [...previousDocuments.keys()].sort(compareText)) {
      if (currentById.has(id)) continue;
      removeDocumentFromPostings(postings, id, previousDocuments.get(id));
      removedIds.push(id);
    }
  }

  for (const card of [...index.cards].sort((left, right) => compareText(left.id, right.id))) {
    const hash = searchDocumentHash(card);
    const oldDocument = previousDocuments.get(card.id);
    if (oldDocument?.hash === hash) {
      documents.set(card.id, oldDocument);
      reusedCards += 1;
      continue;
    }

    if (oldDocument) removeDocumentFromPostings(postings, card.id, oldDocument);
    const document = buildSearchDocument(card, hash);
    addDocumentToPostings(postings, card.id, document);
    documents.set(card.id, document);
    changedIds.push(card.id);
    indexedCards += 1;
  }

  const cardIds = [...documents.keys()].sort(compareText);
  const tokens = [...postings.keys()].sort(compareText);
  const cardIndex = new Map(cardIds.map((id, indexValue) => [id, indexValue]));
  const serializedDocuments = cardIds.map((id) => {
    const document = documents.get(id);
    return [document.hash, document.phrases];
  });
  const serializedPostings = tokens.map((token) =>
    [...(postings.get(token)?.entries() ?? [])]
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, vector]) => [cardIndex.get(id), vector]),
  );
  const cardSetHash = searchCardSetHash(index.cards);
  const searchIndex = {
    schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
    encoding: SEARCH_INDEX_ENCODING,
    tokenizerVersion: TOKENIZER_VERSION,
    repositoryId: index.repositoryId ?? "",
    cardSetHash,
    documentCount: index.cards.length,
    fieldOrder: [...SEARCH_FIELD_ORDER],
    cardIds,
    tokens,
    documents: serializedDocuments,
    postings: serializedPostings,
  };

  return {
    searchIndex,
    stats: {
      previousUsable,
      totalCards: index.cards.length,
      reusedCards,
      indexedCards,
      removedCards: removedIds.length,
      changedIds: changedIds.sort(compareText),
      removedIds: removedIds.sort(compareText),
      tokenCount: tokens.length,
    },
  };
}

export function buildSearchDocument(card, hash = searchDocumentHash(card)) {
  const fieldValues = {
    id: card.id.replaceAll(".", " "),
    role: card.role,
    search: (card.search ?? []).join(" "),
    owns: (card.owns ?? []).join(" "),
    excludes: (card.excludes ?? []).join(" "),
    invariant: (card.invariant ?? []).join(" "),
    effect: (card.effect ?? []).join(" "),
    risk: (card.risk ?? []).join(" "),
    symbol: card.location?.symbol ?? "",
    path: card.location?.path ?? "",
    signature: card.location?.signature ?? "",
  };

  const termMap = new Map();
  for (const [fieldIndex, field] of SEARCH_FIELD_ORDER.entries()) {
    const counts = countTokens(tokenize(fieldValues[field]));
    for (const [token, count] of counts) {
      const sparse = termMap.get(token) ?? new Map();
      sparse.set(fieldIndex, count);
      termMap.set(token, sparse);
    }
  }

  const terms = [...termMap.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([token, sparse]) => [token, serializeSparseVector(sparse)]);
  const phrases = [card.role, ...(card.search ?? []), ...(card.invariant ?? []), ...(card.owns ?? [])]
    .filter(Boolean)
    .map(normalizeSearchText);

  return {
    hash,
    phrases,
    terms,
    tokens: terms.map(([token]) => token),
  };
}

export function searchDocumentHash(card) {
  return sha256(
    stableJson({
      id: card.id,
      role: card.role,
      search: card.search ?? [],
      owns: card.owns ?? [],
      excludes: card.excludes ?? [],
      invariant: card.invariant ?? [],
      effect: card.effect ?? [],
      risk: card.risk ?? [],
      symbol: card.location?.symbol ?? null,
      path: card.location?.path ?? null,
      signature: card.location?.signature ?? null,
    }),
  );
}

export function searchCardSetHash(cards) {
  return sha256(
    [...cards]
      .sort((left, right) => compareText(left.id, right.id))
      .map((card) => `${card.id}:${searchDocumentHash(card)}`)
      .join("\n"),
  );
}

export function isCompatibleSearchIndex(searchIndex, repositoryId = undefined) {
  return Boolean(
    searchIndex &&
      searchIndex.schemaVersion === SEARCH_INDEX_SCHEMA_VERSION &&
      searchIndex.encoding === SEARCH_INDEX_ENCODING &&
      searchIndex.tokenizerVersion === TOKENIZER_VERSION &&
      Array.isArray(searchIndex.fieldOrder) &&
      SEARCH_FIELD_ORDER.every((field, index) => searchIndex.fieldOrder[index] === field) &&
      Array.isArray(searchIndex.cardIds) &&
      isSortedUniqueStrings(searchIndex.cardIds) &&
      Array.isArray(searchIndex.tokens) &&
      isSortedUniqueStrings(searchIndex.tokens) &&
      Array.isArray(searchIndex.documents) &&
      searchIndex.documents.length === searchIndex.cardIds.length &&
      Array.isArray(searchIndex.postings) &&
      searchIndex.postings.length === searchIndex.tokens.length &&
      (repositoryId === undefined || searchIndex.repositoryId === (repositoryId ?? "")),
  );
}

export function verifySearchIndex(index, searchIndex) {
  if (!isCompatibleSearchIndex(searchIndex, index.repositoryId)) return false;
  if (searchIndex.documentCount !== index.cards.length) return false;
  if (searchIndex.cardSetHash !== searchCardSetHash(index.cards)) return false;
  const cards = new Map(index.cards.map((card) => [card.id, card]));
  if (searchIndex.cardIds.length !== cards.size) return false;
  for (const [cardIndex, id] of searchIndex.cardIds.entries()) {
    const card = cards.get(id);
    const document = searchIndex.documents[cardIndex];
    if (!card || !Array.isArray(document) || document[0] !== searchDocumentHash(card)) return false;
  }
  try {
    deserializeSearchIndex(searchIndex);
  } catch {
    return false;
  }
  return true;
}

export function renderSearchIndex(searchIndex) {
  return stableStringify(searchIndex);
}

function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function addDocumentToPostings(postings, id, document) {
  for (const [token, vector] of document.terms ?? []) {
    const tokenPostings = postings.get(token) ?? new Map();
    tokenPostings.set(id, vector);
    postings.set(token, tokenPostings);
  }
}

function removeDocumentFromPostings(postings, id, document) {
  for (const token of document?.tokens ?? []) {
    const tokenPostings = postings.get(token);
    if (!tokenPostings) continue;
    tokenPostings.delete(id);
    if (tokenPostings.size === 0) postings.delete(token);
  }
}

function deserializeSearchIndex(searchIndex) {
  const documents = new Map();
  for (const [cardIndex, id] of searchIndex.cardIds.entries()) {
    const serialized = searchIndex.documents[cardIndex];
    if (
      typeof id !== "string" ||
      !Array.isArray(serialized) ||
      serialized.length !== 2 ||
      typeof serialized[0] !== "string" ||
      !Array.isArray(serialized[1]) ||
      !serialized[1].every((phrase) => typeof phrase === "string")
    ) {
      throw new Error("Malformed compact search document.");
    }
    documents.set(id, {
      hash: serialized[0],
      phrases: serialized[1],
      tokens: [],
    });
  }

  const postings = new Map();
  for (const [tokenIndex, token] of searchIndex.tokens.entries()) {
    if (typeof token !== "string") throw new Error("Malformed compact search token.");
    const tokenPostings = new Map();
    let previousCardIndex = -1;
    for (const entry of searchIndex.postings[tokenIndex] ?? []) {
      if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]) || !Array.isArray(entry[1])) {
        throw new Error("Malformed compact search posting.");
      }
      const cardIndex = entry[0];
      const vector = entry[1];
      if (cardIndex <= previousCardIndex || cardIndex < 0 || cardIndex >= searchIndex.cardIds.length) {
        throw new Error("Compact search postings are not strictly ordered card ordinals.");
      }
      validateSparseVector(vector);
      previousCardIndex = cardIndex;
      const id = searchIndex.cardIds[cardIndex];
      const document = documents.get(id);
      if (!document) throw new Error("Compact search posting references an unknown card.");
      tokenPostings.set(id, vector);
      document.tokens.push(token);
    }
    if (tokenPostings.size > 0) postings.set(token, tokenPostings);
  }
  return { documents, postings };
}

function validateSparseVector(vector) {
  if (vector.length === 0 || vector.length % 2 !== 0) throw new Error("Malformed compact search field vector.");
  let previousFieldIndex = -1;
  for (let index = 0; index < vector.length; index += 2) {
    const fieldIndex = vector[index];
    const count = vector[index + 1];
    if (
      !Number.isInteger(fieldIndex) ||
      fieldIndex <= previousFieldIndex ||
      fieldIndex < 0 ||
      fieldIndex >= SEARCH_FIELD_ORDER.length ||
      !Number.isInteger(count) ||
      count <= 0
    ) {
      throw new Error("Malformed compact search field vector.");
    }
    previousFieldIndex = fieldIndex;
  }
}

function isSortedUniqueStrings(values) {
  let previous = null;
  for (const value of values) {
    if (typeof value !== "string" || (previous !== null && compareText(previous, value) >= 0)) return false;
    previous = value;
  }
  return true;
}

function serializeSparseVector(sparse) {
  const output = [];
  for (const [fieldIndex, count] of [...sparse.entries()].sort(([left], [right]) => left - right)) {
    output.push(fieldIndex, count);
  }
  return output;
}
