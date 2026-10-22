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
  for (const file of project.fileRecords) {
    throwIfAborted(options.signal);
    const cardIds = [...(cardIdsByPath.get(file.relativePath) ?? [])].sort(compareText);
    const base = { path: file.relativePath, cardIds };
    const pathTokens = sourceTokens(file.relativePath);
    const fileCandidate = { ...base, source: "file", line: 1 };
    addCandidate(results, fileCandidate, queryTokens, normalized, pathTokens);
    for (const declaration of extractSourceDeclarations(file.source, file.relativePath)) {
      throwIfAborted(options.signal);
      addCandidate(results, {
        ...base, source: "declaration", line: declaration.line,
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
