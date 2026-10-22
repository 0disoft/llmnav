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
import { throwIfAborted } from "./abort.js";
import { loadConfig } from "./config.js";
import { SEARCH_LIMITS, SEARCH_RANK } from "./policy.js";
import { resolveRegistryId, loadRegistry } from "./registry.js";
import { renderCompactCard } from "./generator.js";
import { assertNoSymlinkTraversal, approximateTokens, compareText, readJsonSafe, readText, sha256, toPosix, truncateToTokenBudget } from "./util.js";
import {
  buildInvertedIndex,
  isCompatibleSearchIndex,
  SEARCH_FIELD_ORDER,
  SEARCH_FIELD_WEIGHTS,
  verifySearchIndex,
} from "./inverted-index.js";
import { normalizeSearchText, tokenize } from "./tokenizer.js";
import { loadPromptPrefixBundleLocked } from "./prompt-bundle.js";
import { recoverGenerationTransaction, withGenerationLock } from "./transaction.js";
import { findGraphNode, isCompatibleRepositoryGraph, renderGraphNode, resolveGraphNode } from "./graph.js";

const preparedIndexCache = new WeakMap();
const preparedSearchIndexCache = new WeakMap();
const sessionGraphAdjacencyCache = new WeakMap();
const sessionSearchMetadataCache = new WeakMap();
const indexCardLookupCache = new WeakMap();

export class SemanticIdLookupError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "SemanticIdLookupError";
    this.reason = reason;
  }
}

export async function loadSearchData(root, options = {}) {
  return withGenerationLock(root, (lock) => loadSearchDataLocked(root, lock, options), options);
}

async function loadSearchDataLocked(root, lock, options = {}) {
  const { config } = await loadConfig(root, options);
  await recoverGenerationTransaction(root, { cacheDirectory: config.generation.cacheDirectory, lockOwnerId: lock.ownerId });
  const cacheRoot = path.join(root, config.generation.cacheDirectory);
  await assertNoSymlinkTraversal(root, cacheRoot, config.generation.cacheDirectory);
  const indexPath = path.join(cacheRoot, "index.json");
  const manifestPath = path.join(cacheRoot, "manifest.json");
  const graphPath = path.join(cacheRoot, "graph.json");
  const searchPath = path.join(cacheRoot, "search-index.json");
  const lexiconPath = path.join(root, ".llmnav", "lexicon.json");
  for (const managedPath of [indexPath, manifestPath, graphPath, searchPath, lexiconPath]) {
    await assertNoSymlinkTraversal(root, managedPath, toPosix(path.relative(root, managedPath)));
  }
  const indexText = await readText(indexPath, null, options);
  if (indexText === null) throw new Error("No generated index found. Run `llmnav generate` first.");
  let index;
  try {
    index = JSON.parse(indexText);
  } catch (error) {
    throw new Error("Malformed primary index.json. Run `llmnav generate` to rebuild it.", { cause: error });
  }
  if (!isUsablePrimaryIndex(index, config.repositoryId)) {
    throw new Error("Incompatible primary index.json. Run `llmnav generate` to rebuild it.");
  }
  const lexicon = await readJsonSafe(lexiconPath, { version: 1, aliases: {} }, options);
  const cacheRelative = toPosix(config.generation.cacheDirectory).replace(/\/+$/u, "");
  const manifestText = await readText(manifestPath, null, options);
  let manifest = null;
  if (manifestText !== null) {
    try {
      manifest = JSON.parse(manifestText);
    } catch (error) {
      throw new Error("Malformed generated manifest.json. Run `llmnav generate` to rebuild it.", { cause: error });
    }
    if (manifest?.repositoryId !== config.repositoryId ||
      manifest.files?.[`${cacheRelative}/index.json`] !== sha256(indexText)) {
      throw new Error("Primary index.json hash does not match manifest.json. Run `llmnav generate` to rebuild it.");
    }
  }
  const graphRelative = `${cacheRelative}/graph.json`;
  const graphText = await readText(graphPath, null, options);
  let graph = null;
  if (graphText !== null) {
    try {
      graph = JSON.parse(graphText);
    } catch {
      // The graph is optional enrichment: a missing or malformed artifact
      // degrades to index-only search instead of failing the query.
      graph = null;
    }
  }
  const graphMatches = Boolean(
    graphText !== null &&
      manifest?.files?.[graphRelative] === sha256(graphText) &&
      isCompatibleRepositoryGraph(graph, index.repositoryId),
  );
  if (!graphMatches) graph = null;
  const searchRelative = `${cacheRelative}/search-index.json`;
  const searchText = await readText(searchPath, null, options);
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

function isUsablePrimaryIndex(index, repositoryId) {
  if (!index || index.schemaVersion !== 1 || index.repositoryId !== repositoryId || !Array.isArray(index.cards)) return false;
  const ids = new Set();
  for (const card of index.cards) {
    if (!card || typeof card.id !== "string" || !card.id || typeof card.role !== "string" || ids.has(card.id)) return false;
    ids.add(card.id);
    for (const field of ["search", "owns", "excludes", "invariant", "effect", "risk", "rel"]) {
      if (card[field] !== undefined && (!Array.isArray(card[field]) || card[field].some((value) => typeof value !== "string"))) return false;
    }
  }
  return true;
}

export async function queryProject(root, query, options = {}) {
  throwIfAborted(options.signal);
  const { index, lexicon, searchIndex, graph } = await loadSearchData(root, options);
  throwIfAborted(options.signal);
  return detachSearchResults(queryPreparedIndex(index, searchIndex, query, { ...options, lexicon, graph }));
}

export async function createProjectSession(root, options = {}) {
  const withPromptBundle = options.withPromptBundle === true;
  const { signal, ...sessionOptions } = options;
  let snapshot = await loadSessionSnapshot(root, { ...options, withPromptBundle });
  const session = {
    root,
    ...(withPromptBundle ? { promptBundle: snapshot.promptBundle, generationHash: snapshot.generationHash } : {}),
    query(query, options = {}) {
      return detachSearchResults(queryPreparedIndex(snapshot.index, snapshot.searchIndex, query, {
        ...options,
        lexicon: snapshot.lexicon,
        graph: snapshot.graph,
      }));
    },
    show(id, options = {}) {
      throwIfAborted(options.signal);
      return structuredClone(showSnapshotCard(snapshot, id));
    },
    registrySnapshot() {
      // Clone so a read-only consumer cannot mutate the session's snapshot.
      return structuredClone(snapshot.registry);
    },
    context(id, options = {}) {
      return buildSnapshotContext(snapshot, id, options);
    },
    async refresh(refreshOptions = {}) {
      const next = await loadSessionSnapshot(root, { ...sessionOptions, ...refreshOptions, withPromptBundle });
      snapshot = next;
      if (withPromptBundle) {
        session.promptBundle = next.promptBundle;
        session.generationHash = next.generationHash;
      }
      return session;
    },
  };
  return session;
}

async function loadSessionSnapshot(root, options = {}) {
  const snapshot = await loadProjectSnapshot(root, options);
  // Only session-owned graphs are cached: public query inputs may be mutable.
  if (snapshot.graph) sessionGraphAdjacencyCache.set(snapshot.graph, buildGraphAdjacency(snapshot.graph));
  sessionSearchMetadataCache.set(snapshot.index, prepareSearchMetadata(snapshot.index, snapshot.lexicon, snapshot.graph, true));
  return snapshot;
}

function indexCardLookup(index) {
  let lookup = indexCardLookupCache.get(index);
  if (lookup === undefined) {
    lookup = new Map(index.cards.map((card) => [card.id, card]));
    indexCardLookupCache.set(index, lookup);
  }
  return lookup;
}

function prepareSearchMetadata(index, lexicon, graph, forSession = false) {
  const normalizedIds = index.cards.map((card) => normalizeSearchText(card.id));
  return {
    byId: new Map(index.cards.map((card) => [card.id, card])),
    cardOrder: new Map(index.cards.map((card, position) => [card.id, position])),
    normalizedIds,
    idCandidates: forSession ? buildIdCandidates(normalizedIds) : null,
    aliases: Object.entries(lexicon.aliases ?? {}).map(([alias, targets]) => [alias, targets, normalizeSearchText(alias)]),
    graphCompatible: isCompatibleRepositoryGraph(graph, index.repositoryId),
  };
}

function buildIdCandidates(normalizedIds) {
  const exact = new Map();
  const grams = new Map();
  for (const [position, id] of normalizedIds.entries()) {
    if (!exact.has(id)) exact.set(id, []);
    exact.get(id).push(position);
    const seen = new Set();
    for (let offset = 0; offset <= id.length - 3; offset += 1) {
      const gram = id.slice(offset, offset + 3);
      if (seen.has(gram)) continue;
      seen.add(gram);
      if (!grams.has(gram)) grams.set(gram, []);
      grams.get(gram).push(position);
    }
  }
  return { exact, grams };
}

function idCandidatePositions(prepared, normalizedQuery) {
  if (!prepared.idCandidates) return prepared.normalizedIds.keys();
  if (normalizedQuery.length < 3) return prepared.idCandidates.exact.get(normalizedQuery) ?? [];
  let smallest = null;
  for (let offset = 0; offset <= normalizedQuery.length - 3; offset += 1) {
    const positions = prepared.idCandidates.grams.get(normalizedQuery.slice(offset, offset + 3));
    if (!positions) return [];
    if (!smallest || positions.length < smallest.length) smallest = positions;
  }
  return smallest ?? [];
}

async function loadProjectSnapshot(root, options = {}) {
  return withGenerationLock(root, async (lock) => {
    const { index, lexicon, searchIndex, graph } = await loadSearchDataLocked(root, lock, options);
    const registry = await loadRegistry(root);
    const prompt = options.withPromptBundle ? await loadPromptPrefixBundleLocked(root, lock) : null;
    return { index, lexicon, searchIndex, graph, registry, promptBundle: prompt?.bundle, generationHash: prompt?.generationHash };
  }, options);
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
  return detachSearchResults(queryPreparedIndex(index, searchIndex, query, options));
}

/**
 * Search an already prepared index.
 *
 * This is the lowest-level query primitive: results borrow the card objects owned
 * by `index`, so callers that keep the index alive must clone what they expose or
 * use `queryIndex` / `createProjectSession`, which detach their results.
 */
export function queryPreparedIndex(index, searchIndex, query, options = {}) {
  const top = boundedInteger(options.top, SEARCH_LIMITS.top.default, SEARCH_LIMITS.top.minimum, SEARCH_LIMITS.top.maximum);
  const lexicon = options.lexicon ?? { aliases: {} };
  const metrics = options.metrics ?? null;
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenize(query);
  const cached = sessionSearchMetadataCache.get(index);
  const prepared = cached ?? prepareSearchMetadata(index, lexicon, options.graph);
  const aliases = prepared.aliases;
  const aliasTargets = new Set();
  const aliasReasons = new Map();
  const { byId, cardOrder } = prepared;
  const resultsById = new Map();
  throwIfAborted(options.signal);

  if (metrics) {
    metrics.queryTokens = queryTokens.length;
    metrics.documentTokenizations = 0;
    metrics.postingVisits = 0;
    metrics.phraseDocumentsScanned = 0;
    metrics.idDocumentsScanned = 0;
    metrics.graphEdgesVisited = 0;
    metrics.idNormalizations = cached ? 0 : index.cards.length;
    metrics.lookupBuilds = cached ? 0 : 2;
    metrics.graphValidations = cached ? 0 : 1;
  }

  for (const [alias, targetValue, normalizedAlias] of aliases) {
    if (!normalizedAlias || !normalizedQuery.includes(normalizedAlias)) continue;
    const targets = Array.isArray(targetValue) ? targetValue : [targetValue];
    for (const target of targets) {
      aliasTargets.add(target);
      const reasons = aliasReasons.get(target) ?? [];
      reasons.push(`alias=${JSON.stringify(alias)}`);
      aliasReasons.set(target, reasons);
    }
  }

  for (const position of idCandidatePositions(prepared, normalizedQuery)) {
    throwIfAborted(options.signal);
    if (metrics) metrics.idDocumentsScanned += 1;
    const card = index.cards[position];
    const normalizedId = prepared.normalizedIds[position];
    if (normalizedId === normalizedQuery) {
      addScore(resultsById, card, SEARCH_RANK.exactSemanticId, "exact semantic ID");
    } else if (normalizedId.includes(normalizedQuery) && normalizedQuery.length >= SEARCH_RANK.semanticIdPhraseMinimumQueryLength) {
      addScore(resultsById, card, SEARCH_RANK.semanticIdPhrase, "semantic ID phrase");
    }
  }
  for (const target of aliasTargets) {
    const card = byId.get(target);
    if (card) addScore(resultsById, card, SEARCH_RANK.alias, aliasReasons.get(target) ?? []);
  }

  const preparedSearchIndex = prepareCompactSearchIndex(searchIndex);
  const documentCount = index.cards.length;
  for (const token of queryTokens) {
    const tokenIndex = preparedSearchIndex.tokenIndex.get(token);
    const tokenPostings = tokenIndex === undefined ? [] : (searchIndex.postings[tokenIndex] ?? []);
    const frequency = tokenPostings.length;
    const idf = Math.log(1 + (documentCount + 1) / (frequency + 1));
    for (const [cardIndex, vector] of tokenPostings) {
    throwIfAborted(options.signal);
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

  if (normalizedQuery.length >= SEARCH_RANK.exactPhraseMinimumQueryLength) {
    for (const [cardIndex, document] of searchIndex.documents.entries()) {
      throwIfAborted(options.signal);
      if (metrics) metrics.phraseDocumentsScanned += 1;
      const phrases = Array.isArray(document) && Array.isArray(document[1]) ? document[1] : [];
      if (!phrases.some((field) => field.includes(normalizedQuery))) continue;
      const card = byId.get(searchIndex.cardIds[cardIndex]);
      if (card) addScore(resultsById, card, SEARCH_RANK.exactPhrase, "exact phrase");
    }
  }

  const results = [...resultsById.values()].filter((result) => result.score > 0);
  const seeds = [...results]
    .sort((left, right) => right.score - left.score || (cardOrder.get(left.card.id) ?? 0) - (cardOrder.get(right.card.id) ?? 0))
    .slice(0, SEARCH_RANK.seedCount);
  if (prepared.graphCompatible) {
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
      score: Number(result.score.toFixed(SEARCH_RANK.scorePrecision)),
      reasons: [...new Set(result.reasons)].slice(0, SEARCH_RANK.reasonLimit),
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
  const top = boundedInteger(options.top, SEARCH_LIMITS.top.default, SEARCH_LIMITS.top.minimum, SEARCH_LIMITS.top.maximum);
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
      score += SEARCH_RANK.exactSemanticId;
      reasons.push("exact semantic ID");
    } else if (normalizeSearchText(card.id).includes(normalizedQuery) && normalizedQuery.length >= SEARCH_RANK.semanticIdPhraseMinimumQueryLength) {
      score += SEARCH_RANK.semanticIdPhrase;
      reasons.push("semantic ID phrase");
    }

    if (aliasTargets.has(card.id)) {
      score += SEARCH_RANK.alias;
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
    if (normalizedQuery.length >= SEARCH_RANK.exactPhraseMinimumQueryLength && phraseFields.some((field) => field.includes(normalizedQuery))) {
      score += SEARCH_RANK.exactPhrase;
      reasons.push("exact phrase");
    }

    if (score > 0) results.push({ card, score, reasons: [...new Set(reasons)].slice(0, SEARCH_RANK.reasonLimit) });
  }

  const byId = new Map(results.map((result) => [result.card.id, result]));
  const seeds = [...results].sort((left, right) => right.score - left.score).slice(0, SEARCH_RANK.seedCount);
  for (const seed of seeds) {
    for (const relation of seed.card.rel ?? []) {
      const separator = relation.indexOf(">");
      if (separator <= 0) continue;
      const target = relation.slice(separator + 1);
      const targetCard = indexCardLookup(index).get(target) ?? null;
      if (!targetCard) continue;
      const existing = byId.get(target);
      const bonus = seed.score * SEARCH_RANK.relationBonusFactor;
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

  return detachSearchResults(
    results
      .sort((left, right) => right.score - left.score || compareText(left.card.id, right.card.id))
      .slice(0, top)
      .map((result) => ({
        id: result.card.id,
        score: Number(result.score.toFixed(SEARCH_RANK.scorePrecision)),
        reasons: [...new Set(result.reasons)].slice(0, SEARCH_RANK.reasonLimit),
        role: result.card.role,
        location: result.card.location,
        card: result.card,
      })),
  );
}

// Public results must never alias a live index snapshot: callers may edit role, location, or reasons.
function detachSearchResults(results) {
  return results.map((result) => {
    const card = structuredClone(result.card);
    return { ...result, location: card.location, card };
  });
}

export async function showProjectCard(root, id, options = {}) {
  return showSnapshotCard(await loadProjectSnapshot(root, options), id);
}

function showSnapshotCard(snapshot, id) {
  const { index, graph, registry } = snapshot;
  const cards = indexCardLookup(index);
  const direct = cards.get(id) ?? null;
  if (direct) return { card: direct, node: null, resolvedFrom: null };
  if (!String(id).includes("/")) {
    const resolved = resolveRegistryId(registry, id);
    if (resolved.state === "active") {
      const card = cards.get(resolved.id) ?? null;
      if (card) return { card, node: null, resolvedFrom: resolved };
    }
    if (resolved.state === "ambiguous" || resolved.state === "cycle") {
      return { card: null, node: null, resolvedFrom: resolved };
    }
  }
  const graphResolution = resolveGraphNode(graph, id, index.repositoryId);
  if (graphResolution.state !== "resolved") return { card: null, node: null, resolvedFrom: graphResolution };
  const localId = localSemanticId(graphResolution.node.key, index.repositoryId);
  const card = localId ? cards.get(localId) ?? null : null;
  return { card, node: card ? null : graphResolution.node, resolvedFrom: graphResolution };
}

export async function buildContext(root, id, options = {}) {
  return buildSnapshotContext(await loadProjectSnapshot(root, options), id, options);
}

function buildSnapshotContext(snapshot, id, options = {}) {
  throwIfAborted(options.signal);
  const { index, graph, registry } = snapshot;
  const depth = boundedInteger(options.depth, SEARCH_LIMITS.depth.default, SEARCH_LIMITS.depth.minimum, SEARCH_LIMITS.depth.maximum);
  const budget = boundedInteger(options.budget, SEARCH_LIMITS.budget.default, SEARCH_LIMITS.budget.minimum, SEARCH_LIMITS.budget.maximum);
  const maxEdges = boundedInteger(options.maxEdges, SEARCH_LIMITS.maxEdges.default, SEARCH_LIMITS.maxEdges.minimum, SEARCH_LIMITS.maxEdges.maximum);
  const cards = indexCardLookup(index);
  const direct = cards.get(id) ?? null;
  let rootId = direct?.id ?? null;
  if (!rootId && !String(id).includes("/")) {
    const resolved = resolveRegistryId(registry, id);
    if (resolved.state === "active" && cards.has(resolved.id)) rootId = resolved.id;
    if (resolved.state === "ambiguous") {
      throw new SemanticIdLookupError("ambiguous", `Ambiguous replaced semantic ID ${id}; choose one of ${resolved.candidates.join(", ")}.`);
    }
    if (resolved.state === "cycle") throw new SemanticIdLookupError("registry_cycle", `Registry cycle prevents resolving semantic ID ${id}.`);
  }
  if (isCompatibleRepositoryGraph(graph, index.repositoryId)) {
    const resolution = rootId
      ? resolveGraphNode(graph, `${index.repositoryId}/${rootId}`, index.repositoryId)
      : resolveGraphNode(graph, id, index.repositoryId);
    if (resolution.state === "ambiguous") {
      throw new SemanticIdLookupError("ambiguous", `Ambiguous semantic ID ${id}; qualify one of ${resolution.candidates.join(", ")}.`);
    }
    if (resolution.state !== "resolved") throw new SemanticIdLookupError("not_found", `Unknown or inactive semantic ID ${id}.`);
    return buildGraphContext(index, graph, resolution.node, { depth, budget, maxEdges });
  }
  if (!rootId) throw new SemanticIdLookupError("not_found", `Unknown or inactive semantic ID ${id}.`);
  return buildLegacyContext(index, rootId, { depth, budget, maxEdges });
}

function buildGraphContext(index, graph, rootNode, options) {
  const { depth, budget, maxEdges } = options;
  const byId = indexCardLookup(index);
  const graphAdjacency = buildGraphAdjacency(graph);
  const queue = [{ key: rootNode.key, depth: 0 }];
  const visited = new Set();
  const selected = [];
  const selectedEdges = [];
  const seenEdges = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.key)) continue;
    visited.add(current.key);
    const node = findGraphNode(graph, current.key);
    if (!node) continue;
    const localId = localSemanticId(node.key, index.repositoryId);
    selected.push({ node, card: localId ? byId.get(localId) ?? null : null });
    if (current.depth >= depth) continue;
    for (const entry of graphAdjacency.get(current.key) ?? []) {
      if (selectedEdges.length >= maxEdges) break;
      if (!seenEdges.has(entry.edge.id)) {
        selectedEdges.push(entry.edge);
        seenEdges.add(entry.edge.id);
      }
      queue.push({ key: entry.neighbor, depth: current.depth + 1 });
    }
  }

  const rootOutputId = contextNodeId(rootNode, index.repositoryId);
  let output = `llmnav-context/1 root=${rootOutputId} depth=${depth}\n`;
  const included = [];
  for (const item of selected) {
    const rendered = `${item.card ? renderCompactCard(item.card) : renderGraphNode(item.node)}\n\n`;
    if (approximateTokens(output + rendered) > budget) {
      if (included.length === 0) {
        output = truncateToTokenBudget(output + rendered, budget);
        included.push(contextNodeId(item.node, index.repositoryId));
      }
      break;
    }
    output += rendered;
    included.push(contextNodeId(item.node, index.repositoryId));
  }
  const includedEdges = [];
  for (const edge of selectedEdges) {
    const rendered = renderGraphEdge(edge);
    if (approximateTokens(output + rendered) > budget) break;
    output += rendered;
    includedEdges.push(edge.id);
  }
  return {
    id: rootOutputId,
    depth,
    budget,
    maxEdges,
    included,
    includedEdges,
    text: truncateToTokenBudget(output.trimEnd(), budget),
  };
}

function buildLegacyContext(index, rootId, options) {
  const { depth, budget, maxEdges } = options;
  const byId = indexCardLookup(index);
  const start = byId.get(rootId);
  if (!start) throw new Error(`No indexed source card exists for semantic ID ${rootId}.`);
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
  let traversedEdges = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    const card = byId.get(current.id);
    if (!card) continue;
    selected.push(card);
    if (current.depth >= depth) continue;
    for (const relation of card.rel ?? []) {
      if (traversedEdges >= maxEdges) break;
      const target = relation.slice(relation.indexOf(">") + 1);
      queue.push({ id: target, depth: current.depth + 1 });
      traversedEdges += 1;
    }
    for (const source of reverse.get(card.id) ?? []) {
      if (traversedEdges >= maxEdges) break;
      queue.push({ id: source, depth: current.depth + 1 });
      traversedEdges += 1;
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
  return {
    id: rootId,
    depth,
    budget,
    maxEdges,
    included,
    includedEdges: [],
    text: truncateToTokenBudget(output.trimEnd(), budget),
  };
}

function renderGraphEdge(edge) {
  return `graph ${edge.from} -[${edge.kind} confidence=${edge.confidence.toFixed(2)} provenance=${edge.provenance.type}]-> ${edge.to}\n`;
}

function contextNodeId(node, localRepositoryId) {
  return node.repositoryId === localRepositoryId ? node.semanticId : node.key;
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
      const directionWeight = entry.direction === "out" ? 1 : SEARCH_RANK.inboundRelationWeight;
      const bonus = seed.score * SEARCH_RANK.relationBonusFactor * edgeConfidence(entry.edge) * directionWeight;
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
      if (targetCard) addScore(resultsById, targetCard, seed.score * SEARCH_RANK.relationBonusFactor, `related-from=${seed.card.id}`);
    }
  }
}

function buildGraphAdjacency(graph) {
  const cached = sessionGraphAdjacencyCache.get(graph);
  if (cached) return cached;
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
