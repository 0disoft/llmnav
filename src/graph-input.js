/* llmnav/1 module
id=llmnav.graph.import
role=Load and validate optional generated definition and reference indexes without executing repository code.
owns=graph import schema|input normalization|graph input diagnostics|source snapshot consistency
excludes=graph ranking|source mutation
search=definition index import|reference index import|graph input validation
invariant=Compiler facts are combined with scanned source only when their validated contents agree.
rel=workflow>llmnav.index.generate
stability=architecture
*/

import path from "node:path";
import { analysisFilePattern } from "./analysis-languages.js";
import { throwIfAborted } from "./abort.js";
import { collectSourceFiles } from "./files.js";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { ID_PATTERN, CROSS_REPO_ID_PATTERN } from "./spec.js";
import { assertNoSymlinkTraversal, compareText, readBytes, readText, sha256, toPosix } from "./util.js";
import { diagnostic } from "./validator.js";
import { normalizeCodeMetadata } from "./code-metadata.js";

export const GRAPH_INPUT_SCHEMA_VERSION = 3;

export function compilerInputPaths(value) {
  assertObject(value.sourceHashes, "sourceHashes");
  const paths = Object.keys(value.sourceHashes);
  if (paths.length === 0) throw new Error("sourceHashes must not be empty");
  for (const file of paths) {
    normalizeSourcePath(file, "sourceHashes path");
    if (!/^[a-f0-9]{64}$/u.test(value.sourceHashes[file])) throw new Error("sourceHashes values must be SHA-256 hashes");
  }
  return paths;
}

export async function loadGraphInputs(root, config, options = {}) {
  return readGraphInputs(root, config, options);
}

// Internal: consumers combining cards/source excerpts and compiler facts need one snapshot.
export async function loadProjectGraphInputs(project, options = {}) {
  const sourceSnapshot = new Map(project.fileRecords.map(file => [file.relativePath, file.contentHash]));
  return readGraphInputs(project.root, project.config, options, sourceSnapshot);
}

async function readGraphInputs(root, config, options, sourceSnapshot) {
  const indexes = [];
  const diagnostics = [];
  for (const relativePath of [...config.graph.indexFiles].sort(compareText)) {
    const file = toPosix(relativePath);
    const absolutePath = path.join(root, file);
    try {
      await assertNoSymlinkTraversal(root, absolutePath, file);
      const text = await readText(absolutePath, null, options);
      if (text === null) throw new Error("file does not exist");
      const parsed = JSON.parse(text);
      if (parsed.schemaVersion >= 2) {
        normalizeGraphInput(parsed, file);
        await assertCompilerInputFreshSnapshot(root, parsed, config, options, sourceSnapshot);
      }
      indexes.push(normalizeGraphInput(parsed, file, sha256(text)));
    } catch (error) {
      throwIfAborted(options.signal);
      diagnostics.push(
        diagnostic(
          "error",
          "LNV014",
          `Invalid graph index: ${error instanceof Error ? error.message : String(error)}`,
          file,
          1,
        ),
      );
    }
  }
  return { indexes, diagnostics };
}

export function normalizeGraphInput(value, file = "<graph-index>", contentHash = null) {
  assertObject(value, "graph index");
  assertKeys(value, new Set(["schemaVersion", "repositoryId", "generator", "definitions", "references", "sourceHashes"]), "graph index");
  if (![1, 2, GRAPH_INPUT_SCHEMA_VERSION].includes(value.schemaVersion)) throw new Error("schemaVersion must be 1, 2 or 3");
  if (value.schemaVersion >= 2) {
    compilerInputPaths(value);
  } else if (value.sourceHashes !== undefined) throw new Error("sourceHashes requires schemaVersion 2");
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(value.repositoryId ?? "")) {
    throw new Error("repositoryId must match ^[a-z][a-z0-9-]{0,63}$");
  }
  if (value.generator !== undefined && (typeof value.generator !== "string" || !value.generator.trim())) {
    throw new Error("generator must be a non-empty string when present");
  }
  if (!Array.isArray(value.definitions)) throw new Error("definitions must be an array");
  if (!Array.isArray(value.references)) throw new Error("references must be an array");

  const definitions = value.definitions.map((item, index) => normalizeDefinition(item, index, value.repositoryId, value.schemaVersion));
  const definitionIds = new Set();
  for (const definition of definitions) {
    if (definitionIds.has(definition.id)) throw new Error(`definitions contains duplicate ID ${definition.id}`);
    definitionIds.add(definition.id);
  }
  const references = value.references.map((item, index) => normalizeReference(item, index, value.repositoryId));
  definitions.sort((left, right) => compareText(left.id, right.id));
  references.sort(compareReferences);

  return {
    file: toPosix(file),
    contentHash,
    schemaVersion: value.schemaVersion,
    repositoryId: value.repositoryId,
    generator: value.generator?.trim() ?? null,
    definitions,
    references,
  };
}

function normalizeDefinition(value, index, repositoryId, schemaVersion) {
  const name = `definitions[${index}]`;
  assertObject(value, name);
  assertKeys(value, new Set(["id", "symbol", "path", "line", "kind", ...(schemaVersion === 3 ? ["metadata"] : [])]), name);
  const id = normalizeSemanticKey(value.id, repositoryId, `${name}.id`);
  if (typeof value.symbol !== "string" || !value.symbol.trim()) throw new Error(`${name}.symbol must be a non-empty string`);
  const normalizedPath = normalizeSourcePath(value.path, `${name}.path`);
  if (value.line !== undefined && (!Number.isInteger(value.line) || value.line < 1)) {
    throw new Error(`${name}.line must be a positive integer when present`);
  }
  if (value.kind !== undefined && (typeof value.kind !== "string" || !value.kind.trim())) {
    throw new Error(`${name}.kind must be a non-empty string when present`);
  }
  return {
    id,
    symbol: value.symbol.trim(),
    path: normalizedPath,
    line: value.line ?? null,
    kind: value.kind?.trim() ?? null,
    ...(value.metadata === undefined ? {} : { metadata: normalizeCodeMetadata(value.metadata, owner => normalizeSemanticKey(owner, repositoryId, `${name}.metadata.owner`)) }),
  };
}

function normalizeReference(value, index, repositoryId) {
  const name = `references[${index}]`;
  assertObject(value, name);
  assertKeys(value, new Set(["from", "to", "kind", "path", "line", "confidence"]), name);
  const from = normalizeSemanticKey(value.from, repositoryId, `${name}.from`);
  const to = normalizeSemanticKey(value.to, repositoryId, `${name}.to`);
  if (typeof value.kind !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value.kind)) {
    throw new Error(`${name}.kind must be a controlled lower-case identifier`);
  }
  const normalizedPath = value.path === undefined ? null : normalizeSourcePath(value.path, `${name}.path`);
  if (value.line !== undefined && (!Number.isInteger(value.line) || value.line < 1)) {
    throw new Error(`${name}.line must be a positive integer when present`);
  }
  const confidence = value.confidence ?? 0.8;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`${name}.confidence must be a number from 0 to 1`);
  }
  return {
    from,
    to,
    kind: value.kind,
    path: normalizedPath,
    line: value.line ?? null,
    confidence,
  };
}

function normalizeSemanticKey(value, repositoryId, name) {
  if (typeof value !== "string") throw new Error(`${name} must be a semantic ID`);
  const normalized = value.trim();
  if (ID_PATTERN.test(normalized)) return `${repositoryId}/${normalized}`;
  if (CROSS_REPO_ID_PATTERN.test(normalized)) return normalized;
  throw new Error(`${name} must be a local or repository-qualified semantic ID`);
}

function normalizeSourcePath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty relative path`);
  if (value.includes("\\") || /^(?:[A-Za-z]:|\/|~\/)/u.test(value) || value.split("/").includes("..") || /\p{Cc}/u.test(value)) {
    throw new Error(`${name} must be a safe forward-slash relative path`);
  }
  return toPosix(value);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function assertKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name} contains unknown property ${JSON.stringify(key)}`);
  }
}

function compareReferences(left, right) {
  return compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.kind, right.kind) ||
    compareText(left.path ?? "", right.path ?? "") || (left.line ?? 0) - (right.line ?? 0);
}

export async function assertCompilerInputFresh(root, parsed, config, options = {}) {
  return assertCompilerInputFreshSnapshot(root, parsed, config, options);
}

async function assertCompilerInputFreshSnapshot(root, parsed, config, options, sourceSnapshot) {
  const adapter = parsed.generator?.match(/^llmnav-(typescript|javascript|go|python|rust)(?:-syntax)?@1;/u)?.[1];
  if (adapter) {
    const extension = analysisFilePattern(adapter);
    const current = (await collectSourceFiles(root, config, [], options)).map(source => toPosix(path.relative(root, source)))
      .filter(source => extension.test(source)).sort(compareText);
    const expected = Object.keys(parsed.sourceHashes).filter(source => extension.test(source)).sort(compareText);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Compiler source set changed; run llmnav analyze again.");
  }
  await mapWithConcurrency(Object.entries(parsed.sourceHashes), options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY, async ([source, hash]) => {
    const sourcePath = path.join(root, source);
    await assertNoSymlinkTraversal(root, sourcePath, source);
    const bytes = await readBytes(sourcePath, null, options);
    if (bytes === null) throw new Error(`Stale compiler analysis for ${source}; run llmnav analyze again.`);
    // Reuse the same consumed bytes for graph freshness and scanned-text consistency.
    const byteHash = sha256(bytes);
    let textHash;
    const matches = expected => byteHash === expected || (textHash ??= sha256(bytes.toString("utf8"))) === expected;
    if (!matches(hash)) throw new Error(`Stale compiler analysis for ${source}; run llmnav analyze again.`);
    // Match path.join's lexical normalization so accepted path aliases cannot skip the snapshot check.
    const scannedHash = sourceSnapshot?.get(path.posix.normalize(source));
    if (scannedHash !== undefined && !matches(scannedHash)) throw new Error(`Compiler input changed since source scan: ${source}; retry the operation.`);
  }, { signal: options.signal });
}
