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
import { DISCOVERY_RANK, DISCOVERY_SOURCE_LIMITS, SEARCH_LIMITS } from "./policy.js";
import { normalizeSearchText, tokenize } from "./tokenizer.js";
import { buildLineStarts, compareText, normalizeNewlines } from "./util.js";

export async function discoverProject(root, query, options = {}) {
  throwIfAborted(options.signal);
  if (typeof query !== "string" || !query.trim()) throw new TypeError("discover requires search text.");
  const top = options.top ?? SEARCH_LIMITS.top.default;
  if (!Number.isInteger(top) || top < SEARCH_LIMITS.top.minimum || top > SEARCH_LIMITS.top.maximum) {
    throw new RangeError(`discover top must be an integer from ${SEARCH_LIMITS.top.minimum} to ${SEARCH_LIMITS.top.maximum}.`);
  }
  if (options.includeSource !== undefined && typeof options.includeSource !== "boolean") throw new TypeError("discover includeSource must be a boolean.");
  const sourceBudget = options.sourceBudget ?? DISCOVERY_SOURCE_LIMITS.default;
  if (!Number.isInteger(sourceBudget) || sourceBudget < DISCOVERY_SOURCE_LIMITS.minimum || sourceBudget > DISCOVERY_SOURCE_LIMITS.maximum) {
    throw new RangeError(`discover sourceBudget must be an integer from ${DISCOVERY_SOURCE_LIMITS.minimum} to ${DISCOVERY_SOURCE_LIMITS.maximum} UTF-8 bytes.`);
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
  const spans = new WeakMap();
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
    const fileMatch = addCandidate(results, fileCandidate, queryTokens, normalized, pathTokens);
    if (fileMatch && options.includeSource) spans.set(fileMatch, { text: file.source, start: 0, end: file.source.length, scope: "window" });
    const declarations = compiled === null ? extractSourceDeclarations(file.source, file.relativePath) : compiled.get(file.relativePath) ?? [];
    const lineStarts = options.includeSource && compiled !== null ? buildLineStarts(file.source) : null;
    for (const declaration of declarations) {
      throwIfAborted(options.signal);
      const match = addCandidate(results, {
        ...base, source: compiled === null ? "declaration" : "compiler", line: declaration.line,
        ...(compiled === null ? {} : { id: declaration.id, compiler: declaration.compiler }),
        symbol: declaration.symbol, signature: declaration.signature,
        kind: declaration.kind, language: declaration.language,
      }, queryTokens, normalized, pathTokens);
      if (match && options.includeSource) {
        const start = compiled === null ? declaration.offset : lineStarts[declaration.line - 1];
        if (Number.isInteger(start)) spans.set(match, { text: file.source, start,
          end: compiled === null ? declaration.endOffset : file.source.length, scope: compiled === null ? "declaration" : "window" });
      }
    }
  }
  results.sort((left, right) => right.score - left.score || compareText(left.path, right.path) ||
    left.line - right.line || compareText(left.source, right.source));
  const selected = results.slice(0, top);
  if (options.includeSource) packSource(selected, spans, sourceBudget);
  return {
    schemaVersion: 1,
    repositoryId: project.config.repositoryId,
    results: selected,
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
  if (score <= 0) return null;
  const result = { ...candidate, score, reasons };
  results.push(result);
  return result;
}

function packSource(results, spans, budget) {
  let remaining = budget;
  for (const candidate of results) {
    const span = spans.get(candidate);
    if (!span || remaining === 0) continue;
    // Even all-CRLF text needs at most twice the remaining byte budget in
    // input characters. Never copy an entire large body just to truncate it.
    const end = Math.min(span.end, span.start + remaining * 2 + 2);
    const source = normalizeNewlines(span.text.slice(span.start, end));
    let bytes = 0, length = 0;
    for (const character of source) {
      const size = Buffer.byteLength(character);
      if (bytes + size > remaining) break;
      bytes += size;
      length += character.length;
    }
    const text = source.slice(0, length);
    candidate.sourceExcerpt = { scope: span.scope, startLine: candidate.line,
      endLine: candidate.line + (text.match(/\n/gu)?.length ?? 0) - Number(text.endsWith("\n")),
      text, truncated: end < span.end || length < source.length };
    remaining -= bytes;
  }
}
