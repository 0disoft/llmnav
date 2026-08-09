/* llmnav/1 module
id=llmnav.search.query
role=Rank cards from task language and pack confidence-weighted repository graph context.
owns=query ranking|graph ranking|multilingual aliases|context expansion
excludes=embedding generation|source mutation
search=semantic code search|graph-aware ranking|agent navigation|multilingual query
rel=workflow>llmnav.index.generate
rel=workflow>llmnav.index.inverted
rel=workflow>llmnav.graph.generate
stability=architecture
*/

import path from "node:path";
import { loadConfig } from "./config.js";
import { resolveRegistryId, loadRegistry } from "./registry.js";
import { renderCompactCard } from "./generator.js";
import { approximateTokens, compareText, readJsonSafe, readText, sha256, toPosix, truncateToTokenBudget } from "./util.js";
import {
  buildInvertedIndex,
  isCompatibleSearchIndex,
  SEARCH_FIELD_ORDER,
  SEARCH_FIELD_WEIGHTS,
  verifySearchIndex,
} from "./inverted-index.js";
import { normalizeSearchText, tokenize } from "./tokenizer.js";
import { recoverGenerationTransaction } from "./transaction.js";
import { isCompatibleRepositoryGraph } from "./graph.js";

const preparedIndexCache = new WeakMap();
const preparedSearchIndexCache = new WeakMap();

export async function loadSearchData(root) {
  const { config } = await loadConfig(root);
  await recoverGenerationTransaction(root, { cacheDirectory: config.generation.cacheDirectory });
  const cacheRoot = path.join(root, config.generation.cacheDirectory);
  const index = await readJsonSafe(path.join(cacheRoot, "index.json"), null);
  if (!index) throw new Error("No generated index found. Run `llmnav generate` first.");
  const lexicon = await readJsonSafe(path.join(root, ".llmnav", "lexicon.json"), { version: 1, aliases: {} });
  const manifest = await readJsonSafe(path.join(cacheRoot, "manifest.json"), null);
  const graphRelative = `${toPosix(config.generation.cacheDirectory).replace(/\/+$/u, "")}/graph.json`;
  const graphText = await readText(path.join(cacheRoot, "graph.json"), null);
  let graph = null;
  if (graphText !== null) {
    try {
      graph = JSON.parse(graphText);
    } catch {
      graph = null;
    }
  }
  const graphMatches = Boolean(
    graphText !== null &&
      manifest?.files?.[graphRelative] === sha256(graphText) &&
      isCompatibleRepositoryGraph(graph, index.repositoryId),
  );
  if (!graphMatches) graph = null;
  const searchRelative = `${toPosix(config.generation.cacheDirectory).replace(/\/+$/u, "")}/search-index.json`;
  const searchText = await readText(path.join(cacheRoot, "search-index.json"), null);
  let searchIndex = null;
  if (searchText !== null) {
    try {
      searchIndex = JSON.parse(searchText);
    } catch {
      searchIndex = null;
    }
  }
  const manifestMatches = Boolean(
    searchText !== null &&
      manifest?.searchCardSetHash &&
      searchIndex?.cardSetHash === manifest.searchCardSetHash &&
      searchIndex?.documentCount === index.cards.length &&
      manifest.files?.[searchRelative] === sha256(searchText),
  );
  if (!isCompatibleSearchIndex(searchIndex, index.repositoryId) || (!manifestMatches && !verifySearchIndex(index, searchIndex))) {
    searchIndex = buildInvertedIndex(index).searchIndex;
  }
  return { index, lexicon, searchIndex, graph };
}

export async function queryProject(root, query, options = {}) {
  const { index, lexicon, searchIndex, graph } = await loadSearchData(root);
  return queryPreparedIndex(index, searchIndex, query, { ...options, lexicon, graph });
}

export function queryIndex(index, query, options = {}) {
  let searchIndex = options.invertedIndex;
  if (!searchIndex) {
    searchIndex = preparedIndexCache.get(index);
    if (!searchIndex) {
      searchIndex = buildInvertedIndex(index).searchIndex;
      preparedIndexCache.set(index, searchIndex);
    }
  }
  return queryPreparedIndex(index, searchIndex, query, options);
}

export function queryPreparedIndex(index, searchIndex, query, options = {}) {
  const top = boundedInteger(options.top, 5, 1, 100);
  const lexicon = options.lexicon ?? { aliases: {} };
  const metrics = options.metrics ?? null;
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenize(query);
  const aliases = Object.entries(lexicon.aliases ?? {});
  const aliasTargets = new Set();
  const aliasReasons = new Map();
  const byId = new Map(index.cards.map((card) => [card.id, card]));
  const cardOrder = new Map(index.cards.map((card, cardIndex) => [card.id, cardIndex]));
  const resultsById = new Map();

  if (metrics) {
    metrics.queryTokens = queryTokens.length;
    metrics.documentTokenizations = 0;
    metrics.postingVisits = 0;
    metrics.phraseDocumentsScanned = 0;
    metrics.idDocumentsScanned = 0;
    metrics.graphEdgesVisited = 0;
  }

  for (const [alias, targetValue] of aliases) {
    const normalizedAlias = normalizeSearchText(alias);
    if (!normalizedAlias || !normalizedQuery.includes(normalizedAlias)) continue;
    const targets = Array.isArray(targetValue) ? targetValue : [targetValue];
    for (const target of targets) {
      aliasTargets.add(target);
      const reasons = aliasReasons.get(target) ?? [];
      reasons.push(`alias=${JSON.stringify(alias)}`);
      aliasReasons.set(target, reasons);
    }
  }

  for (const card of index.cards) {
    if (metrics) metrics.idDocumentsScanned += 1;
    if (normalizeSearchText(card.id) === normalizedQuery) {
      addScore(resultsById, card, 1000, "exact semantic ID");
    } else if (normalizeSearchText(card.id).includes(normalizedQuery) && normalizedQuery.length > 2) {
      addScore(resultsById, card, 100, "semantic ID phrase");
    }
    if (aliasTargets.has(card.id)) {
      addScore(resultsById, card, 500, aliasReasons.get(card.id) ?? []);
    }
  }

  const preparedSearchIndex = prepareCompactSearchIndex(searchIndex);
  const documentCount = index.cards.length;
  for (const token of queryTokens) {
    const tokenIndex = preparedSearchIndex.tokenIndex.get(token);
    const tokenPostings = tokenIndex === undefined ? [] : (searchIndex.postings[tokenIndex] ?? []);
    const frequency = tokenPostings.length;
    const idf = Math.log(1 + (documentCount + 1) / (frequency + 1));
    for (const [cardIndex, vector] of tokenPostings) {
      if (metrics) metrics.postingVisits += 1;
      const id = searchIndex.cardIds[cardIndex];
      const card = byId.get(id);
      if (!card) continue;
      let tokenScore = 0;
      for (let vectorIndex = 0; vectorIndex < vector.length; vectorIndex += 2) {
        const field = SEARCH_FIELD_ORDER[vector[vectorIndex]];
        const count = vector[vectorIndex + 1] ?? 0;
        if (field) tokenScore += count * SEARCH_FIELD_WEIGHTS[field] * idf;
      }
      if (tokenScore > 0) addScore(resultsById, card, tokenScore, `token=${token}`);
    }
  }

  if (normalizedQuery.length >= 4) {
    for (const [cardIndex, document] of searchIndex.documents.entries()) {
      if (metrics) metrics.phraseDocumentsScanned += 1;
      const phrases = Array.isArray(document) && Array.isArray(document[1]) ? document[1] : [];
      if (!phrases.some((field) => field.includes(normalizedQuery))) continue;
      const card = byId.get(searchIndex.cardIds[cardIndex]);
      if (card) addScore(resultsById, card, 40, "exact phrase");
    }
  }

  const results = [...resultsById.values()].filter((result) => result.score > 0);
  const seeds = [...results]
    .sort((left, right) => right.score - left.score || (cardOrder.get(left.card.id) ?? 0) - (cardOrder.get(right.card.id) ?? 0))
    .slice(0, 3);
  if (isCompatibleRepositoryGraph(options.graph, index.repositoryId)) {
    applyGraphBonuses(index, options.graph, seeds, byId, resultsById, metrics);
  } else {
    applyLegacyRelationBonuses(seeds, byId, resultsById);
  }

  return [...resultsById.values()]
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || compareText(left.card.id, right.card.id))
    .slice(0, top)
    .map((result) => ({
      id: result.card.id,
      score: Number(result.score.toFixed(3)),
      reasons: [...new Set(result.reasons)].slice(0, 6),
      role: result.card.role,
      location: result.card.location,
      card: result.card,
    }));
}

function prepareCompactSearchIndex(searchIndex) {
  let prepared = preparedSearchIndexCache.get(searchIndex);
  if (prepared) return prepared;
  prepared = {
    tokenIndex: new Map((searchIndex.tokens ?? []).map((token, index) => [token, index])),
  };
  preparedSearchIndexCache.set(searchIndex, prepared);
  return prepared;
}

export function queryIndexLegacy(index, query, options = {}) {
  const top = boundedInteger(options.top, 5, 1, 100);
  const lexicon = options.lexicon ?? { aliases: {} };
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenize(query);
  const aliases = Object.entries(lexicon.aliases ?? {});
  const aliasTargets = new Set();
  const aliasReasons = new Map();

  for (const [alias, targetValue] of aliases) {
    const normalizedAlias = normalizeSearchText(alias);
    if (!normalizedAlias || !normalizedQuery.includes(normalizedAlias)) continue;
    const targets = Array.isArray(targetValue) ? targetValue : [targetValue];
    for (const target of targets) {
      aliasTargets.add(target);
      const reasons = aliasReasons.get(target) ?? [];
      reasons.push(`alias=${JSON.stringify(alias)}`);
      aliasReasons.set(target, reasons);
    }
  }

  const documents = index.cards.map((card) => buildLegacyDocument(card));
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of new Set(document.allTokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const results = [];
  for (const [cardIndex, card] of index.cards.entries()) {
    const document = documents[cardIndex];
    let score = 0;
    const reasons = [];

    if (normalizeSearchText(card.id) === normalizedQuery) {
      score += 1000;
      reasons.push("exact semantic ID");
    } else if (normalizeSearchText(card.id).includes(normalizedQuery) && normalizedQuery.length > 2) {
      score += 100;
      reasons.push("semantic ID phrase");
    }

    if (aliasTargets.has(card.id)) {
      score += 500;
      reasons.push(...(aliasReasons.get(card.id) ?? []));
    }

    for (const token of queryTokens) {
      const frequency = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (index.cards.length + 1) / (frequency + 1));
      let tokenScore = 0;
      for (const [field, weight] of Object.entries(SEARCH_FIELD_WEIGHTS)) {
        const count = document.fields[field]?.filter((item) => item === token).length ?? 0;
        tokenScore += count * weight * idf;
      }
      if (tokenScore > 0) {
        score += tokenScore;
        reasons.push(`token=${token}`);
      }
    }

    const phraseFields = [card.role, ...(card.search ?? []), ...(card.invariant ?? []), ...(card.owns ?? [])]
      .filter(Boolean)
      .map(normalizeSearchText);
    if (normalizedQuery.length >= 4 && phraseFields.some((field) => field.includes(normalizedQuery))) {
      score += 40;
      reasons.push("exact phrase");
    }

    if (score > 0) results.push({ card, score, reasons: [...new Set(reasons)].slice(0, 6) });
  }

  const byId = new Map(results.map((result) => [result.card.id, result]));
  const seeds = [...results].sort((left, right) => right.score - left.score).slice(0, 3);
  for (const seed of seeds) {
    for (const relation of seed.card.rel ?? []) {
      const separator = relation.indexOf(">");
      if (separator <= 0) continue;
      const target = relation.slice(separator + 1);
      const targetCard = index.cards.find((card) => card.id === target);
      if (!targetCard) continue;
      const existing = byId.get(target);
      const bonus = seed.score * 0.08;
      if (existing) {
        existing.score += bonus;
        existing.reasons.push(`related-from=${seed.card.id}`);
      } else {
        const result = { card: targetCard, score: bonus, reasons: [`related-from=${seed.card.id}`] };
        results.push(result);
        byId.set(target, result);
      }
    }
  }

  return results
    .sort((left, right) => right.score - left.score || compareText(left.card.id, right.card.id))
    .slice(0, top)
    .map((result) => ({
      id: result.card.id,
      score: Number(result.score.toFixed(3)),
      reasons: [...new Set(result.reasons)].slice(0, 6),
      role: result.card.role,
      location: result.card.location,
      card: result.card,
    }));
}

export async function showProjectCard(root, id) {
  const { index } = await loadSearchData(root);
  const direct = index.cards.find((card) => card.id === id);
  if (direct) return { card: direct, resolvedFrom: null };
  const registry = await loadRegistry(root);
  const resolved = resolveRegistryId(registry, id);
  if (resolved.state !== "active") return { card: null, resolvedFrom: resolved };
  return {
    card: index.cards.find((card) => card.id === resolved.id) ?? null,
    resolvedFrom: resolved,
  };
}

export async function buildContext(root, id, options = {}) {
  const { index, graph } = await loadSearchData(root);
  const registry = await loadRegistry(root);
  const direct = index.cards.find((card) => card.id === id);
  const resolved = direct ? { id, state: "active" } : resolveRegistryId(registry, id);
  if (resolved.state !== "active") throw new Error(`Unknown or inactive semantic ID ${id}.`);
  const rootId = resolved.id;
  const depth = boundedInteger(options.depth, 1, 0, 8);
  const budget = boundedInteger(options.budget, 2500, 128, 100000);
  const maxEdges = boundedInteger(options.maxEdges, 24, 0, 1000);
  const start = index.cards.find((card) => card.id === rootId);
  if (!start) throw new Error(`No indexed source card exists for semantic ID ${rootId}.`);
  const byId = new Map(index.cards.map((card) => [card.id, card]));
  const reverse = new Map();
  for (const card of index.cards) {
    for (const relation of card.rel ?? []) {
      const target = relation.slice(relation.indexOf(">") + 1);
      const list = reverse.get(target) ?? [];
      list.push(card.id);
      reverse.set(target, list);
    }
  }

  const queue = [{ id: rootId, depth: 0 }];
  const visited = new Set();
  const selected = [];
  const selectedEdges = [];
  const seenEdges = new Set();
  const graphAdjacency = isCompatibleRepositoryGraph(graph, index.repositoryId)
    ? buildGraphAdjacency(graph)
    : null;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    const card = byId.get(current.id);
    if (!card) continue;
    selected.push(card);
    if (current.depth >= depth) continue;
    if (graphAdjacency) {
      const key = `${index.repositoryId}/${card.id}`;
      for (const entry of graphAdjacency.get(key) ?? []) {
        if (selectedEdges.length >= maxEdges) break;
        if (!seenEdges.has(entry.edge.id)) {
          selectedEdges.push(entry.edge);
          seenEdges.add(entry.edge.id);
        }
        const target = localSemanticId(entry.neighbor, index.repositoryId);
        if (target) queue.push({ id: target, depth: current.depth + 1 });
      }
    } else {
      for (const relation of card.rel ?? []) {
        const target = relation.slice(relation.indexOf(">") + 1);
        queue.push({ id: target, depth: current.depth + 1 });
      }
      for (const source of reverse.get(card.id) ?? []) queue.push({ id: source, depth: current.depth + 1 });
    }
  }

  const header = `llmnav-context/1 root=${rootId} depth=${depth}\n`;
  let output = header;
  const included = [];
  for (const card of selected) {
    const rendered = `${renderCompactCard(card)}\n\n`;
    if (approximateTokens(output + rendered) > budget) {
      if (included.length === 0) {
        output = truncateToTokenBudget(output + rendered, budget);
        included.push(card.id);
      }
      break;
    }
    output += rendered;
    included.push(card.id);
  }
  const includedEdges = [];
  for (const edge of selectedEdges) {
    const rendered = `graph ${edge.from} -[${edge.kind} confidence=${edge.confidence.toFixed(2)} provenance=${edge.provenance.type}]-> ${edge.to}\n`;
    if (approximateTokens(output + rendered) > budget) break;
    output += rendered;
    includedEdges.push(edge.id);
  }
  return {
    id: rootId,
    depth,
    budget,
    maxEdges,
    included,
    includedEdges,
    text: truncateToTokenBudget(output.trimEnd(), budget),
  };
}

function applyGraphBonuses(index, graph, seeds, byId, resultsById, metrics) {
  const adjacency = buildGraphAdjacency(graph);
  for (const seed of seeds) {
    const key = `${index.repositoryId}/${seed.card.id}`;
    for (const entry of adjacency.get(key) ?? []) {
      if (metrics) metrics.graphEdgesVisited += 1;
      const target = localSemanticId(entry.neighbor, index.repositoryId);
      const targetCard = target ? byId.get(target) : null;
      if (!targetCard) continue;
      const directionWeight = entry.direction === "out" ? 1 : 0.6;
      const bonus = seed.score * 0.08 * edgeConfidence(entry.edge) * directionWeight;
      if (bonus <= 0) continue;
      addScore(
        resultsById,
        targetCard,
        bonus,
        `graph-${entry.direction}:${entry.edge.kind}@${edgeConfidence(entry.edge).toFixed(2)}`,
      );
    }
  }
}

function applyLegacyRelationBonuses(seeds, byId, resultsById) {
  for (const seed of seeds) {
    for (const relation of seed.card.rel ?? []) {
      const separator = relation.indexOf(">");
      if (separator <= 0) continue;
      const target = relation.slice(separator + 1);
      const targetCard = byId.get(target);
      if (targetCard) addScore(resultsById, targetCard, seed.score * 0.08, `related-from=${seed.card.id}`);
    }
  }
}

function buildGraphAdjacency(graph) {
  const adjacency = new Map();
  for (const edge of [...graph.edges].sort(compareGraphEdgesForTraversal)) {
    appendGraphNeighbor(adjacency, edge.from, { neighbor: edge.to, direction: "out", edge });
    appendGraphNeighbor(adjacency, edge.to, { neighbor: edge.from, direction: "in", edge });
  }
  for (const entries of adjacency.values()) {
    entries.sort((left, right) =>
      edgeConfidence(right.edge) - edgeConfidence(left.edge) ||
      compareText(left.edge.kind, right.edge.kind) ||
      compareText(left.neighbor, right.neighbor) ||
      compareText(left.edge.id, right.edge.id),
    );
  }
  return adjacency;
}

function appendGraphNeighbor(adjacency, key, entry) {
  const values = adjacency.get(key) ?? [];
  values.push(entry);
  adjacency.set(key, values);
}

function localSemanticId(key, repositoryId) {
  const prefix = `${repositoryId}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

function edgeConfidence(edge) {
  return Math.max(0, Math.min(1, Number(edge.confidence) || 0));
}

function compareGraphEdgesForTraversal(left, right) {
  return compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.kind, right.kind) ||
    compareText(left.id, right.id);
}

function addScore(resultsById, card, score, reasons) {
  const existing = resultsById.get(card.id) ?? { card, score: 0, reasons: [] };
  existing.score += score;
  if (Array.isArray(reasons)) existing.reasons.push(...reasons);
  else existing.reasons.push(reasons);
  resultsById.set(card.id, existing);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.isInteger(value) ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function buildLegacyDocument(card) {
  const fields = {
    id: tokenize(card.id.replaceAll(".", " ")),
    role: tokenize(card.role),
    search: tokenize((card.search ?? []).join(" ")),
    owns: tokenize((card.owns ?? []).join(" ")),
    excludes: tokenize((card.excludes ?? []).join(" ")),
    invariant: tokenize((card.invariant ?? []).join(" ")),
    effect: tokenize((card.effect ?? []).join(" ")),
    risk: tokenize((card.risk ?? []).join(" ")),
    symbol: tokenize(card.location?.symbol ?? ""),
    path: tokenize(card.location?.path ?? ""),
    signature: tokenize(card.location?.signature ?? ""),
  };
  return { fields, allTokens: Object.values(fields).flat() };
}

export { tokenize } from "./tokenizer.js";
