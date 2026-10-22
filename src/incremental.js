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
import { throwIfAborted } from "./abort.js";
import { loadConfig } from "./config.js";
import { createDeclarationScanContext, findAttachedDeclaration, extractImports } from "./declaration.js";
import { collectSourceFiles } from "./files.js";
import { parseLlmnavBlocks } from "./parser.js";
import { loadRegistry } from "./registry.js";
import { loadModuleResolution } from "./module-resolution.js";
import {
  assertNoSymlinkTraversal,
  atomicWrite,
  compareText,
  readJsonSafe,
  readText,
  relativePosix,
  sha256,
  stableStringify,
} from "./util.js";

export const FILE_STATE_SCHEMA_VERSION = 1;
export const SOURCE_INDEXER_VERSION = 8;
const STAT_HINTS_SCHEMA_VERSION = 2;

export async function scanProjectIncremental(root, options = {}) {
  const { config, configPath } = await loadConfig(root);
  const files = await collectSourceFiles(root, config, options.paths ?? [], { signal: options.signal });
  const cacheDirectory = path.join(root, config.generation.cacheDirectory);
  const { previousFiles, hintFiles, hintsPath } = await loadIncrementalState(root, config, cacheDirectory, options);
  const scan = createIncrementalScan(root, files, previousFiles, hintFiles);

  for (const absolutePath of files) {
    throwIfAborted(options.signal);
    await scanSourceFile(scan, absolutePath);
  }

  const { fileState, statHints } = buildIncrementalArtifacts(scan);
  const registry = await loadRegistry(root);
  const moduleResolution = await loadModuleResolution(root, scan.fileRecords);
  const project = {
    root,
    config,
    configPath,
    files,
    fileRecords: scan.fileRecords,
    records: scan.records,
    registry,
    moduleResolution,
    sourceBytes: scan.sourceBytes,
    semanticBytes: scan.semanticBytes,
    incremental: scan.stats,
  };

  return { project, fileState, statHints, hintsPath, stats: scan.stats };
}

async function loadIncrementalState(root, config, cacheDirectory, options) {
  await assertNoSymlinkTraversal(root, cacheDirectory, config.generation.cacheDirectory);
  const fileStatePath = path.join(cacheDirectory, "file-state.json");
  await assertNoSymlinkTraversal(root, fileStatePath, relativePosix(root, fileStatePath));
  const fileStateSource = options.previousState
    ? renderFileState(options.previousState)
    : await readText(fileStatePath, null);
  let previousState = null;
  try {
    previousState = fileStateSource === null ? null : JSON.parse(fileStateSource);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const manifest = await readJsonSafe(path.join(cacheDirectory, "manifest.json"), null);
  const previousStateHash = fileStateSource === null ? null : sha256(fileStateSource);
  const fileStateKey = `${relativePosix(root, cacheDirectory)}/file-state.json`;
  const trustedPreviousState = usableFileState(previousState) &&
    (options.previousState != null ||
      (manifest?.schemaVersion === 1 && manifest.repositoryId === config.repositoryId &&
        manifest.files?.[fileStateKey] === previousStateHash));
  const hintsPath = path.join(root, ".llmnav", "state", "stat-hints.json");
  await assertNoSymlinkTraversal(root, hintsPath, relativePosix(root, hintsPath));
  const previousHints = options.useStatHints === false
    ? null
    : await readJsonSafe(hintsPath, null);
  const previousFiles = trustedPreviousState ? mapStateFiles(previousState.files) : new Map();
  const hintFiles = trustedPreviousState && usableStatHints(previousHints) &&
    previousHints.fileStateHash === previousStateHash ? previousHints.files : {};
  return { previousFiles, hintFiles, hintsPath };
}

function createIncrementalScan(root, files, previousFiles, hintFiles) {
  return {
    root,
    previousFiles,
    hintFiles,
    seenPaths: new Set(),
    fileRecords: [],
    records: [],
    nextStateFiles: [],
    nextHintFiles: {},
    sourceBytes: 0,
    semanticBytes: 0,
    stats: {
      totalFiles: files.length,
      parsedFiles: 0,
      reusedFiles: 0,
      reusedFilesByStat: 0,
      reusedFilesByHash: 0,
      deletedFiles: 0,
      bytesRead: 0,
      cardsParsed: 0,
      cardsReused: 0,
    },
  };
}

async function scanSourceFile(scan, absolutePath) {
  const relativePath = relativePosix(scan.root, absolutePath);
  const details = await stat(absolutePath, { bigint: true });
  const fingerprint = statFingerprint(details);
  scan.seenPaths.add(relativePath);
  const stateFile = await reuseOrParseFile(scan, {
    absolutePath,
    relativePath,
    fingerprint,
    previousFile: scan.previousFiles.get(relativePath),
    previousHint: scan.hintFiles[relativePath],
  });
  const normalizedStateFile = normalizeStateFile(stateFile, relativePath);
  scan.nextHintFiles[relativePath] = { ...fingerprint, contentHash: normalizedStateFile.contentHash };
  scan.nextStateFiles.push(normalizedStateFile);
  scan.sourceBytes += normalizedStateFile.sourceBytes;
  scan.semanticBytes += normalizedStateFile.semanticBytes;
  scan.fileRecords.push(hydrateFileRecord(scan.root, absolutePath, normalizedStateFile));
  scan.records.push(...hydrateRecords(scan.root, absolutePath, normalizedStateFile));
}

async function reuseOrParseFile(scan, { absolutePath, relativePath, fingerprint, previousFile, previousHint }) {
  if (previousFile && previousHint?.contentHash === previousFile.contentHash &&
    fingerprintsEqual(previousHint, fingerprint)) {
    scan.stats.reusedFiles += 1;
    scan.stats.reusedFilesByStat += 1;
    scan.stats.cardsReused += previousFile.blocks.length;
    return previousFile;
  }
  const source = await readFile(absolutePath, "utf8");
  scan.stats.bytesRead += Buffer.byteLength(source);
  const contentHash = sha256(source);
  if (previousFile?.contentHash === contentHash) {
    scan.stats.reusedFiles += 1;
    scan.stats.reusedFilesByHash += 1;
    scan.stats.cardsReused += previousFile.blocks.length;
    return previousFile;
  }
  const stateFile = analyzeFile(relativePath, source);
  scan.stats.parsedFiles += 1;
  scan.stats.cardsParsed += stateFile.blocks.length;
  return stateFile;
}

function buildIncrementalArtifacts(scan) {
  for (const previousPath of scan.previousFiles.keys()) {
    if (!scan.seenPaths.has(previousPath)) scan.stats.deletedFiles += 1;
  }
  const nextStateFiles = [...scan.nextStateFiles].sort((left, right) => compareText(left.path, right.path));
  const fileState = {
    schemaVersion: FILE_STATE_SCHEMA_VERSION,
    indexerVersion: SOURCE_INDEXER_VERSION,
    files: nextStateFiles,
  };
  const statHints = {
    schemaVersion: STAT_HINTS_SCHEMA_VERSION,
    fileStateHash: sha256(renderFileState(fileState)),
    files: Object.fromEntries(Object.entries(scan.nextHintFiles).sort(([left], [right]) => compareText(left, right))),
  };
  return { fileState, statHints };
}

export function buildFileStateFromProject(project) {
  const files = project.fileRecords.map((fileRecord) => {
    const source = fileRecord.source ?? "";
    const declarationScanContext = createDeclarationScanContext(source);
    const declarations = fileRecord.blocks.map((block) =>
      findAttachedDeclaration(source, block, fileRecord.relativePath, declarationScanContext),
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

export async function persistStatHints(root, hintsPath, statHints) {
  await assertNoSymlinkTraversal(root, hintsPath, relativePosix(root, hintsPath));
  await atomicWrite(root, hintsPath, stableStringify(statHints));
}

export function renderFileState(fileState) {
  return stableStringify(fileState);
}

export function usableFileState(value) {
  if (!value || value.schemaVersion !== FILE_STATE_SCHEMA_VERSION ||
    value.indexerVersion !== SOURCE_INDEXER_VERSION || !Array.isArray(value.files)) return false;
  const paths = new Set();
  for (const file of value.files) {
    if (!file || typeof file.path !== "string" || !file.path || file.path.startsWith("/") ||
      file.path.includes("\\") || file.path.split("/").includes("..") || paths.has(file.path) ||
      !/^[0-9a-f]{64}$/u.test(file.contentHash) ||
      !Number.isSafeInteger(file.sourceBytes) || file.sourceBytes < 0 ||
      !Number.isSafeInteger(file.semanticBytes) || file.semanticBytes < 0 ||
      !Array.isArray(file.imports) || !file.imports.every((item) => typeof item === "string") ||
      !Array.isArray(file.blocks) || !file.blocks.every((block) => block &&
        typeof block.raw === "string" && block.card && typeof block.card.id === "string") ||
      !Array.isArray(file.declarations) || file.declarations.length !== file.blocks.length) return false;
    paths.add(file.path);
  }
  return true;
}

function analyzeFile(relativePath, source) {
  const blocks = parseLlmnavBlocks(source, relativePath);
  const declarationScanContext = createDeclarationScanContext(source);
  return {
    path: relativePath,
    contentHash: sha256(source),
    sourceBytes: Buffer.byteLength(source),
    semanticBytes: blocks.reduce((sum, block) => sum + Buffer.byteLength(block.raw), 0),
    imports: extractImports(source, relativePath),
    blocks,
    declarations: blocks.map((block) => findAttachedDeclaration(source, block, relativePath, declarationScanContext)),
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
  return Boolean(value && value.schemaVersion === STAT_HINTS_SCHEMA_VERSION &&
    /^[0-9a-f]{64}$/u.test(value.fileStateHash) && value.files &&
    typeof value.files === "object" && !Array.isArray(value.files));
}
