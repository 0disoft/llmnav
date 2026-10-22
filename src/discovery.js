/* llmnav/1 module
id=llmnav.search.discover
role=Find source files and heuristic declarations before a repository has semantic cards or generated indexes.
owns=unannotated source navigation|file and declaration ranking|candidate provenance
excludes=business rule inference|source mutation|semantic ID assignment
search=cardless code search|first source exploration|find declaration without cards
invariant=Automatic candidates carry source provenance and never claim reviewed semantic contracts.
rel=workflow>llmnav.declaration.extract
rel=workflow>llmnav.audit.coverage
stability=architecture
*/

import { throwIfAborted } from "./abort.js";
import { extractSourceDeclarations } from "./declaration.js";
import { loadGraphInputs } from "./graph-input.js";
import { scanProject } from "./project.js";
import { DISCOVERY_RANK, SEARCH_LIMITS } from "./policy.js";
import { normalizeSearchText, tokenize } from "./tokenizer.js";
import { compareText } from "./util.js";

export async function discoverProject(root, query, options = {}) {
  throwIfAborted(options.signal);
  if (typeof query !== "string" || !query.trim()) throw new TypeError("discover requires search text.");
  const top = options.top ?? SEARCH_LIMITS.top.default;
  if (!Number.isInteger(top) || top < SEARCH_LIMITS.top.minimum || top > SEARCH_LIMITS.top.maximum) {
    throw new RangeError(`discover top must be an integer from ${SEARCH_LIMITS.top.minimum} to ${SEARCH_LIMITS.top.maximum}.`);
  }
  const project = await scanProject(root, options);
  const queryTokens = [...new Set(tokenize(query))];
  const normalized = normalizeSearchText(query);
  const cardIdsByPath = new Map();
  for (const record of project.records) {
    if (!record.card.id) continue;
    const ids = cardIdsByPath.get(record.relativePath) ?? new Set();
    ids.add(record.card.id);
    cardIdsByPath.set(record.relativePath, ids);
  }
  const results = [];
  let compiled = null;
  if (options.precise === true) {
    const loaded = await loadGraphInputs(root, project.config, options);
    if (loaded.diagnostics.length) throw new Error(loaded.diagnostics.map(item => item.message).join("; "));
    compiled = new Map();
    for (const index of loaded.indexes) {
      for (const definition of index.definitions) {
        if (definition.kind === "module") continue;
        const list = compiled.get(definition.path) ?? [];
        list.push({ ...definition, compiler: index.generator }); compiled.set(definition.path, list);
      }
    }
    if (!loaded.indexes.length) throw new Error("No configured compiler graph. Run llmnav analyze, configure graph.indexFiles, and generate first.");
  }
  for (const file of project.fileRecords) {
    throwIfAborted(options.signal);
    const cardIds = [...(cardIdsByPath.get(file.relativePath) ?? [])].sort(compareText);
    const base = { path: file.relativePath, cardIds };
    const pathTokens = sourceTokens(file.relativePath);
    const fileCandidate = { ...base, source: "file", line: 1 };
    addCandidate(results, fileCandidate, queryTokens, normalized, pathTokens);
    const declarations = compiled === null ? extractSourceDeclarations(file.source, file.relativePath) : compiled.get(file.relativePath) ?? [];
    for (const declaration of declarations) {
      throwIfAborted(options.signal);
      addCandidate(results, {
        ...base, source: compiled === null ? "declaration" : "compiler", line: declaration.line,
        ...(compiled === null ? {} : { id: declaration.id, compiler: declaration.compiler }),
        symbol: declaration.symbol, signature: declaration.signature,
        kind: declaration.kind, language: declaration.language,
      }, queryTokens, normalized, pathTokens);
    }
  }
  results.sort((left, right) => right.score - left.score || compareText(left.path, right.path) ||
    left.line - right.line || compareText(left.source, right.source));
  return {
    schemaVersion: 1,
    repositoryId: project.config.repositoryId,
    results: results.slice(0, top),
    matched: results.length,
    truncated: results.length > top,
  };
}

function sourceTokens(value = "") {
  const words = value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
  return new Set([...tokenize(value), ...tokenize(words)]);
}

function addCandidate(results, candidate, queryTokens, normalized, pathTokens) {
  const symbolTokens = sourceTokens(candidate.symbol);
  const signatureTokens = sourceTokens(candidate.signature);
  const reasons = [];
  let score = 0;
  for (const token of queryTokens) {
    if (symbolTokens.has(token)) { score += DISCOVERY_RANK.symbolToken; reasons.push(`symbol=${token}`); }
    else if (pathTokens.has(token)) { score += DISCOVERY_RANK.pathToken; reasons.push(`path=${token}`); }
    else if (signatureTokens.has(token)) { score += DISCOVERY_RANK.signatureToken; reasons.push(`signature=${token}`); }
  }
  if (candidate.symbol && normalizeSearchText(candidate.symbol) === normalized) {
    score += DISCOVERY_RANK.exactSymbol;
    reasons.push("exact symbol");
  }
  if (score > 0) results.push({ ...candidate, score, reasons });
}
