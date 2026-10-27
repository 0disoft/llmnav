/* llmnav/1 module
id=llmnav.structure.analyze
role=Connect opt-in compiler or syntax declarations to semantic cards with explicit analysis precision.
owns=compiler adapter orchestration|generated structural IDs|source freshness proofs|analysis publication
excludes=dependency installation|project execution|runtime dispatch inference
search=precise TypeScript analysis|Go type checker|Python AST|Rust syntax|JavaScript metadata
invariant=Analysis output is validated, precision is explicit and source changes invalidate it before publication or graph-input loading.
rel=workflow>llmnav.graph.import
rel=workflow>llmnav.search.discover
stability=architecture
*/

import path from "node:path";
import { analysisFilePattern, analysisIdPrefix } from "./analysis-languages.js";
import { analyzePython } from "./adapters/python.js";
import { analyzeRust } from "./adapters/rust.js";
import { throwIfAborted } from "./abort.js";
import { analyzeTypeScript } from "./adapters/typescript.js";
import { analyzeGo } from "./adapters/go.js";
import { normalizeGraphInput, assertCompilerInputFresh } from "./graph-input.js";
import { validateProject } from "./validator.js";
import { loadConfig } from "./config.js";
import { scanProject } from "./project.js";
import { assertNoSymlinkTraversal, atomicWrite, compareText, readBytes, sha256, stableStringify } from "./util.js";

export async function analyzeProject(root, options = {}) {
  root = path.resolve(root);
  const matches = analysisFilePattern(options.language);
  const project = await scanProject(root, options);
  const errors = validateProject(project).filter(item => item.severity === "error");
  if (errors.length) throw new Error(errors.map(item => `${item.code}: ${item.message}`).join("; "));
  const selected = project.fileRecords.filter(file => matches.test(file.relativePath));
  if (!selected.length) throw new Error(`No selected ${options.language} sources found.`);
  const sourceHashes = Object.fromEntries(selected.map(file => [file.relativePath, file.contentHash]));
  const metadata = options.language === "go" ? ["go.mod", "go.sum"] : ["typescript", "javascript"].includes(options.language)
    ? [options.project, "package-lock.json", "bun.lock", "pnpm-lock.yaml"].filter(Boolean) : [];
  for (const file of metadata) {
    const absolute = path.resolve(root, file);
    await assertNoSymlinkTraversal(root, absolute, file);
    const content = await readBytes(absolute, null, options);
    if (content !== null) sourceHashes[file.split(path.sep).join("/")] = sha256(content);
  }
  const adapter = ({ go: analyzeGo, python: analyzePython, rust: analyzeRust })[options.language] ?? analyzeTypeScript;
  const raw = await adapter(root, selected.map(file => file.absolutePath), options);
  throwIfAborted(options.signal);
  for (const [file, hash] of Object.entries(raw.configHashes ?? {})) {
    if (Object.hasOwn(sourceHashes, file) && sourceHashes[file] !== hash) throw new Error(`Source changed during analysis: ${file}. Run analysis again.`);
    sourceHashes[file] = hash;
  }
  for (const [file, hash] of Object.entries(sourceHashes)) {
    await assertNoSymlinkTraversal(root, path.join(root, file), file);
    const bytes = await readBytes(path.join(root, file), undefined, options);
    if (sha256(bytes) !== hash && sha256(bytes.toString("utf8")) !== hash) throw new Error(`Source changed during analysis: ${file}. Run analysis again.`);
  }
  const graph = connectDefinitions(project, raw, options.language, sourceHashes, options);
  normalizeGraphInput(graph);
  const cardIds = new Set(project.records.map(record => record.card.id));
  return { schemaVersion: 1, language: options.language, compiler: raw.compiler, diagnostics: raw.diagnostics,
    ...(raw.precision ? { precision: raw.precision, limitations: raw.limitations } : {}),
    counts: { definitions: graph.definitions.length, references: graph.references.length, cardBindings: graph.definitions.filter(item => cardIds.has(item.id)).length }, graph };
}

function createCardBindingLookup(records) {
  const symbols = new Map(), modules = new Map();
  for (const record of records) {
    if (record.declaration) {
      const { symbol, offset, line } = record.declaration;
      const key = `${record.relativePath}:${symbol}`;
      const positions = symbols.get(key) ?? { offsets: new Map(), lines: new Map() };
      symbols.set(key, positions);
      countBinding(positions.offsets, offset, record);
      const lineMatch = countBinding(positions.lines, line, record);
      lineMatch.offsets ??= new Map();
      lineMatch.offsets.set(offset, (lineMatch.offsets.get(offset) ?? 0) + 1);
    } else if (record.card.scope === "module") {
      countBinding(modules, record.relativePath, record);
    }
  }
  return item => {
    const positions = symbols.get(`${item.path}:${item.symbol}`);
    let match = item.kind === "module" ? modules.get(item.path) ?? { count: 0 } : matchBindingPosition(positions, item.offset, item.line);
    if (match.count === 0 && item.signatureOffset !== undefined) {
      match = matchBindingPosition(positions, item.signatureOffset, item.signatureLine);
    }
    return match.count === 1 ? match.record : null;
  };
}

function countBinding(index, key, record) {
  let match = index.get(key);
  if (match === undefined) {
    match = { count: 0, record };
    index.set(key, match);
  }
  match.count++;
  return match;
}

function matchBindingPosition(positions, offset, line) {
  // Preserve strict-equality matching; Map alone would also match NaN positions.
  const offsetMatch = Number.isNaN(offset) ? undefined : positions?.offsets.get(offset);
  const lineMatch = Number.isNaN(line) ? undefined : positions?.lines.get(line);
  const overlap = offsetMatch === undefined ? 0 : lineMatch?.offsets.get(offset) ?? 0;
  return { count: (offsetMatch?.count ?? 0) + (lineMatch?.count ?? 0) - overlap,
    record: offsetMatch?.record ?? lineMatch?.record };
}

export function connectDefinitions(project, raw, language, sourceHashes, options = {}) {
  const bindCard = createCardBindingLookup(project.records);
  const ids = new Map(), occurrences = new Map();
  const definitions = [];
  const definitionIds = new Set();
  const declarations = [...raw.declarations].sort((left, right) => compareText(left.path, right.path) || left.offset - right.offset || compareText(left.key, right.key));
  for (const item of declarations) {
    const matchedCard = bindCard(item);
    const identity = `${language}:${item.path}:${item.qualified}`;
    const occurrence = occurrences.get(identity) ?? 0; occurrences.set(identity, occurrence + 1);
    const id = matchedCard ? matchedCard.card.id : `code.${analysisIdPrefix(language)}.s${sha256(`${identity}:${occurrence}`).slice(0, 32)}`;
    ids.set(item.key, id);
    if (!definitionIds.has(id)) {
      definitionIds.add(id);
      definitions.push({ id, symbol: item.display ?? item.symbol, path: item.path, line: item.line, kind: item.kind });
    }
  }
  if (options.metadata === true) {
    const byId = new Map(definitions.map(definition => [definition.id, definition]));
    for (const item of declarations) {
      const definition = byId.get(ids.get(item.key));
      if (definition.metadata) continue;
      const metadata = item.metadata ?? { language, category: "module", status: raw.diagnostics.length ? "partial" : "available", type: null, typeOrigin: "unknown", signatures: [], parameters: [] };
      definition.metadata = { ...metadata, owner: ids.get(metadata.owner ?? item.parent) ?? null };
    }
  }
  const unique = new Map();
  const confidence = raw.diagnostics.length ? 0.8 : 1;
  const add = item => {
    const from = ids.get(item.from), to = ids.get(item.to);
    if (!from || !to || from === to) return;
    const edge = { ...item, from, to, confidence };
    unique.set(JSON.stringify(edge), edge);
  };
  for (const item of declarations) if (item.parent) add({ from: item.parent, to: item.key, kind: "declares", path: item.path, line: item.line });
  for (const item of raw.references) add(item);
  definitions.sort((left, right) => compareText(left.id, right.id));
  const references = [...unique.values()].sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.kind, right.kind) || compareText(left.path, right.path) || left.line - right.line);
  return { schemaVersion: options.metadata === true ? 3 : 2, repositoryId: project.config.repositoryId, generator: `llmnav-${language}${raw.precision === "syntax" ? "-syntax" : ""}@1;${raw.compiler.name}@${raw.compiler.version}`,
    sourceHashes, definitions, references };
}

export async function writeAnalysis(root, relativeOutput, result, options = {}) {
  throwIfAborted(options.signal);
  if (!relativeOutput.endsWith(".json")) throw new TypeError("Analysis output must be a repository-relative JSON file.");
  const target = path.resolve(root, relativeOutput);
  await assertNoSymlinkTraversal(root, target, relativeOutput);
  normalizeGraphInput(result.graph);
  const { config } = await loadConfig(root, options);
  await assertCompilerInputFresh(root, result.graph, config, options);
  await atomicWrite(root, target, stableStringify(result.graph), {
    ...options, beforeCommit: () => assertCompilerInputFresh(root, result.graph, config, options),
  });
  return relativeOutput;
}
