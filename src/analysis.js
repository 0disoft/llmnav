/* llmnav/1 module
id=llmnav.structure.analyze
role=Connect opt-in compiler-resolved TypeScript and Go definitions and references to semantic cards.
owns=compiler adapter orchestration|generated structural IDs|source freshness proofs|analysis publication
excludes=dependency installation|project execution|runtime dispatch inference
search=precise TypeScript analysis|Go type checker|compiler definition reference graph
invariant=Compiler output is validated and source changes invalidate it before publication or compiler-input loading.
rel=workflow>llmnav.graph.import
rel=workflow>llmnav.search.discover
stability=architecture
*/

import path from "node:path";
import { throwIfAborted } from "./abort.js";
import { analyzeTypeScript } from "./adapters/typescript.js";
import { analyzeGo } from "./adapters/go.js";
import { normalizeGraphInput, assertCompilerInputFresh } from "./graph-input.js";
import { validateProject } from "./validator.js";
import { loadConfig } from "./config.js";
import { scanProject } from "./project.js";
import { assertNoSymlinkTraversal, atomicWrite, compareText, readText, sha256, stableStringify } from "./util.js";

export async function analyzeProject(root, options = {}) {
  root = path.resolve(root);
  if (!["typescript", "go"].includes(options.language)) throw new TypeError("analyze requires language typescript or go.");
  const project = await scanProject(root, options);
  const errors = validateProject(project).filter(item => item.severity === "error");
  if (errors.length) throw new Error(errors.map(item => `${item.code}: ${item.message}`).join("; "));
  const matches = options.language === "go" ? /\.go$/u : /\.(?:[cm]?ts|tsx)$/u;
  const selected = project.fileRecords.filter(file => matches.test(file.relativePath));
  if (!selected.length) throw new Error(`No selected ${options.language} sources found.`);
  const sourceHashes = Object.fromEntries(selected.map(file => [file.relativePath, file.contentHash]));
  const metadata = options.language === "go" ? ["go.mod", "go.sum"] : [options.project, "package-lock.json", "bun.lock", "pnpm-lock.yaml"].filter(Boolean);
  for (const file of metadata) {
    const absolute = path.resolve(root, file);
    await assertNoSymlinkTraversal(root, absolute, file);
    const content = await readText(absolute, null, options);
    if (content !== null) sourceHashes[file.split(path.sep).join("/")] = sha256(content);
  }
  const adapter = options.language === "go" ? analyzeGo : analyzeTypeScript;
  const raw = await adapter(root, selected.map(file => file.absolutePath), options);
  throwIfAborted(options.signal);
  for (const [file, hash] of Object.entries(sourceHashes)) {
    await assertNoSymlinkTraversal(root, path.join(root, file), file);
    if (sha256(await readText(path.join(root, file), undefined, options)) !== hash) throw new Error(`Source changed during analysis: ${file}. Run analysis again.`);
  }
  const graph = connectDefinitions(project, raw, options.language, sourceHashes);
  normalizeGraphInput(graph);
  const cardIds = new Set(project.records.map(record => record.card.id));
  return { schemaVersion: 1, language: options.language, compiler: raw.compiler, diagnostics: raw.diagnostics,
    counts: { definitions: graph.definitions.length, references: graph.references.length, cardBindings: graph.definitions.filter(item => cardIds.has(item.id)).length }, graph };
}

function connectDefinitions(project, raw, language, sourceHashes) {
  const symbols = new Map(), modules = new Map();
  for (const record of project.records) {
    if (record.declaration) {
      const key = `${record.relativePath}:${record.declaration.symbol}`;
      const items = symbols.get(key) ?? []; items.push(record); symbols.set(key, items);
    } else if (record.card.scope === "module") {
      const items = modules.get(record.relativePath) ?? []; items.push(record); modules.set(record.relativePath, items);
    }
  }
  const ids = new Map(), occurrences = new Map();
  const definitions = [];
  const definitionIds = new Set();
  const declarations = [...raw.declarations].sort((left, right) => compareText(left.path, right.path) || left.offset - right.offset || compareText(left.key, right.key));
  for (const item of declarations) {
    const matches = item.kind === "module" ? modules.get(item.path) ?? [] :
      (symbols.get(`${item.path}:${item.symbol}`) ?? []).filter(record => record.declaration.offset === item.offset || record.declaration.line === item.line);
    const identity = `${language}:${item.path}:${item.qualified}`;
    const occurrence = occurrences.get(identity) ?? 0; occurrences.set(identity, occurrence + 1);
    const id = matches.length === 1 ? matches[0].card.id : `code.${language === "go" ? "go" : "ts"}.s${sha256(`${identity}:${occurrence}`).slice(0, 32)}`;
    ids.set(item.key, id);
    if (!definitionIds.has(id)) {
      definitionIds.add(id);
      definitions.push({ id, symbol: item.display ?? item.symbol, path: item.path, line: item.line, kind: item.kind });
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
  return { schemaVersion: 2, repositoryId: project.config.repositoryId, generator: `llmnav-${language}@1;${raw.compiler.name}@${raw.compiler.version}`,
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
