/* llmnav/1 module
id=llmnav.index.incremental
role=Reuse unchanged file parses and card records while rebuilding deterministic generated artifacts.
owns=file fingerprints|parsed-file state|incremental scan metrics
excludes=source comment mutation|cache directory commit
search=incremental indexing|file cache|card reuse
rel=workflow>llmnav.index.generate
stability=architecture
*/

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { findAttachedDeclaration, extractImports } from "./declaration.js";
import { collectSourceFiles } from "./files.js";
import { parseLlmnavBlocks } from "./parser.js";
import { loadRegistry } from "./registry.js";
import {
  atomicWrite,
  compareText,
  readJsonSafe,
  relativePosix,
  sha256,
  stableStringify,
} from "./util.js";

export const FILE_STATE_SCHEMA_VERSION = 1;
export const SOURCE_INDEXER_VERSION = 4;
const STAT_HINTS_SCHEMA_VERSION = 1;

export async function scanProjectIncremental(root, options = {}) {
  const { config, configPath } = await loadConfig(root);
  const files = await collectSourceFiles(root, config, options.paths ?? []);
  const cacheDirectory = path.join(root, config.generation.cacheDirectory);
  const previousState = options.previousState ?? await readJsonSafe(path.join(cacheDirectory, "file-state.json"), null);
  const hintsPath = path.join(root, ".llmnav", "state", "stat-hints.json");
  const previousHints = options.useStatHints === false
    ? null
    : await readJsonSafe(hintsPath, null);
  const previousFiles = usableFileState(previousState) ? mapStateFiles(previousState.files) : new Map();
  const hintFiles = usableStatHints(previousHints) ? previousHints.files ?? {} : {};

  const fileRecords = [];
  const records = [];
  const nextStateFiles = [];
  const nextHintFiles = {};
  const seenPaths = new Set();
  const stats = {
    totalFiles: files.length,
    parsedFiles: 0,
    reusedFiles: 0,
    reusedFilesByStat: 0,
    reusedFilesByHash: 0,
    deletedFiles: 0,
    bytesRead: 0,
    cardsParsed: 0,
    cardsReused: 0,
  };
  let sourceBytes = 0;
  let semanticBytes = 0;

  for (const absolutePath of files) {
    const relativePath = relativePosix(root, absolutePath);
    const details = await stat(absolutePath, { bigint: true });
    const fingerprint = statFingerprint(details);
    nextHintFiles[relativePath] = fingerprint;
    seenPaths.add(relativePath);
    const previousFile = previousFiles.get(relativePath);
    const previousHint = hintFiles[relativePath];
    let stateFile;

    if (previousFile && fingerprintsEqual(previousHint, fingerprint)) {
      stateFile = previousFile;
      stats.reusedFiles += 1;
      stats.reusedFilesByStat += 1;
      stats.cardsReused += previousFile.blocks.length;
    } else {
      const source = await readFile(absolutePath, "utf8");
      stats.bytesRead += Buffer.byteLength(source);
      const contentHash = sha256(source);
      if (previousFile?.contentHash === contentHash) {
        stateFile = previousFile;
        stats.reusedFiles += 1;
        stats.reusedFilesByHash += 1;
        stats.cardsReused += previousFile.blocks.length;
      } else {
        stateFile = analyzeFile(relativePath, source);
        stats.parsedFiles += 1;
        stats.cardsParsed += stateFile.blocks.length;
      }
    }

    const normalizedStateFile = normalizeStateFile(stateFile, relativePath);
    nextStateFiles.push(normalizedStateFile);
    sourceBytes += normalizedStateFile.sourceBytes;
    semanticBytes += normalizedStateFile.semanticBytes;
    const fileRecord = hydrateFileRecord(root, absolutePath, normalizedStateFile);
    fileRecords.push(fileRecord);
    records.push(...hydrateRecords(root, absolutePath, normalizedStateFile));
  }

  for (const previousPath of previousFiles.keys()) {
    if (!seenPaths.has(previousPath)) stats.deletedFiles += 1;
  }

  nextStateFiles.sort((left, right) => compareText(left.path, right.path));
  const fileState = {
    schemaVersion: FILE_STATE_SCHEMA_VERSION,
    indexerVersion: SOURCE_INDEXER_VERSION,
    files: nextStateFiles,
  };
  const statHints = {
    schemaVersion: STAT_HINTS_SCHEMA_VERSION,
    files: Object.fromEntries(Object.entries(nextHintFiles).sort(([left], [right]) => compareText(left, right))),
  };
  const registry = await loadRegistry(root);
  const project = {
    root,
    config,
    configPath,
    files,
    fileRecords,
    records,
    registry,
    sourceBytes,
    semanticBytes,
    incremental: stats,
  };

  return { project, fileState, statHints, hintsPath, stats };
}

export function buildFileStateFromProject(project) {
  const files = project.fileRecords.map((fileRecord) => {
    const source = fileRecord.source ?? "";
    const declarations = fileRecord.blocks.map((block) =>
      findAttachedDeclaration(source, block, fileRecord.relativePath),
    );
    return normalizeStateFile(
      {
        path: fileRecord.relativePath,
        contentHash: fileRecord.contentHash ?? sha256(source),
        sourceBytes: Buffer.byteLength(source),
        semanticBytes: fileRecord.blocks.reduce((sum, block) => sum + Buffer.byteLength(block.raw), 0),
        imports: fileRecord.imports,
        blocks: fileRecord.blocks,
        declarations,
      },
      fileRecord.relativePath,
    );
  });
  files.sort((left, right) => compareText(left.path, right.path));
  return {
    schemaVersion: FILE_STATE_SCHEMA_VERSION,
    indexerVersion: SOURCE_INDEXER_VERSION,
    files,
  };
}

export async function persistStatHints(hintsPath, statHints) {
  await atomicWrite(hintsPath, stableStringify(statHints));
}

export function renderFileState(fileState) {
  return stableStringify(fileState);
}

export function usableFileState(value) {
  return Boolean(
    value &&
      value.schemaVersion === FILE_STATE_SCHEMA_VERSION &&
      value.indexerVersion === SOURCE_INDEXER_VERSION &&
      Array.isArray(value.files),
  );
}

function analyzeFile(relativePath, source) {
  const blocks = parseLlmnavBlocks(source, relativePath);
  return {
    path: relativePath,
    contentHash: sha256(source),
    sourceBytes: Buffer.byteLength(source),
    semanticBytes: blocks.reduce((sum, block) => sum + Buffer.byteLength(block.raw), 0),
    imports: extractImports(source, relativePath),
    blocks,
    declarations: blocks.map((block) => findAttachedDeclaration(source, block, relativePath)),
  };
}

function normalizeStateFile(file, relativePath) {
  return {
    path: relativePath,
    contentHash: String(file.contentHash),
    sourceBytes: Number(file.sourceBytes),
    semanticBytes: Number(file.semanticBytes),
    imports: [...(file.imports ?? [])],
    blocks: structuredClone(file.blocks ?? []),
    declarations: structuredClone(file.declarations ?? []),
  };
}

function hydrateFileRecord(root, absolutePath, stateFile) {
  return {
    absolutePath,
    relativePath: stateFile.path,
    source: null,
    contentHash: stateFile.contentHash,
    bodyHash: stateFile.contentHash,
    sourceBytes: stateFile.sourceBytes,
    semanticBytes: stateFile.semanticBytes,
    blocks: stateFile.blocks,
    imports: stateFile.imports,
    root,
  };
}

function hydrateRecords(root, absolutePath, stateFile) {
  return stateFile.blocks.map((block, index) => {
    const declaration = stateFile.declarations[index] ?? null;
    return {
      root,
      absolutePath,
      relativePath: stateFile.path,
      source: null,
      bodyHash: declaration?.bodyHash ?? stateFile.contentHash,
      imports: stateFile.imports,
      block,
      card: block.card,
      declaration,
    };
  });
}

function mapStateFiles(files) {
  const output = new Map();
  for (const file of files ?? []) {
    if (!file || typeof file.path !== "string" || !Array.isArray(file.blocks)) continue;
    output.set(file.path, file);
  }
  return output;
}

function statFingerprint(details) {
  return {
    size: details.size.toString(),
    mtimeNs: details.mtimeNs.toString(),
    ctimeNs: details.ctimeNs.toString(),
  };
}

function fingerprintsEqual(left, right) {
  return Boolean(
    left &&
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs,
  );
}

function usableStatHints(value) {
  return Boolean(value && value.schemaVersion === STAT_HINTS_SCHEMA_VERSION && value.files && typeof value.files === "object");
}
