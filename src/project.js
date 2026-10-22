/* llmnav/1 module
id=llmnav.project.scan
role=Scan project sources into semantic card and file records with declarations, imports, and content hashes.
owns=project scan|card record assembly|source metrics
excludes=semantic validation|cache generation
search=project scan|card records|source metadata
invariant=Generated paths and structural metadata remain derived data and are never written into source cards.
rel=workflow>llmnav.declaration.extract
rel=workflow>llmnav.syntax.parse
stability=architecture
*/

import { readFile } from "node:fs/promises";
import { abortable, throwIfAborted } from "./abort.js";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { loadConfig } from "./config.js";
import { createDeclarationScanContext, findAttachedDeclaration, extractImports } from "./declaration.js";
import { collectSourceFiles } from "./files.js";
import { parseLlmnavBlocks } from "./parser.js";
import { loadRegistry } from "./registry.js";
import { loadModuleResolution } from "./module-resolution.js";
import { relativePosix, sha256 } from "./util.js";

export async function scanProject(root, options = {}) {
  throwIfAborted(options.signal);
  const { config, configPath } = await loadConfig(root, options);
  const ioConcurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;
  const files = await collectSourceFiles(root, config, options.paths ?? [], {
    signal: options.signal,
    ioConcurrency,
  });
  const scanned = await mapWithConcurrency(files, ioConcurrency, async (absolutePath) => {
    throwIfAborted(options.signal);
    const source = await abortable((options.io?.readFile ?? readFile)(absolutePath, "utf8"), options.signal);
    const relativePath = relativePosix(root, absolutePath);
    const blocks = parseLlmnavBlocks(source, relativePath);
    return {
      absolutePath,
      relativePath,
      source,
      blocks,
      contentHash: sha256(source),
      imports: extractImports(source, relativePath),
      declarationScanContext: createDeclarationScanContext(source),
    };
  }, { signal: options.signal });
  const records = [];
  const fileRecords = [];
  let sourceBytes = 0;
  let semanticBytes = 0;

  for (const { absolutePath, relativePath, source, blocks, contentHash, imports, declarationScanContext } of scanned) {
    throwIfAborted(options.signal);
    const fileBytes = Buffer.byteLength(source);
    const fileSemanticBytes = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.raw), 0);
    sourceBytes += fileBytes;
    semanticBytes += fileSemanticBytes;
    const fileRecord = {
      absolutePath,
      relativePath,
      source,
      contentHash,
      bodyHash: contentHash,
      sourceBytes: fileBytes,
      semanticBytes: fileSemanticBytes,
      blocks,
      imports,
    };
    fileRecords.push(fileRecord);
    for (const block of blocks) {
      const declaration = findAttachedDeclaration(source, block, relativePath, declarationScanContext);
      records.push({
        root,
        absolutePath,
        relativePath,
        source,
        bodyHash: declaration?.bodyHash ?? contentHash,
        imports,
        block,
        card: block.card,
        declaration,
      });
    }
  }

  const registry = options.registry ?? await loadRegistry(root, options);
  const moduleResolution = await loadModuleResolution(root, fileRecords);
  throwIfAborted(options.signal);
  return {
    root,
    config,
    configPath,
    files,
    fileRecords,
    records,
    registry,
    moduleResolution,
    sourceBytes,
    semanticBytes,
  };
}
