import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { findAttachedDeclaration, extractImports } from "./declaration.js";
import { collectSourceFiles } from "./files.js";
import { parseLlmnavBlocks } from "./parser.js";
import { loadRegistry } from "./registry.js";
import { relativePosix, sha256 } from "./util.js";

export async function scanProject(root, options = {}) {
  const { config, configPath } = await loadConfig(root);
  const files = await collectSourceFiles(root, config, options.paths ?? []);
  const records = [];
  const fileRecords = [];
  let sourceBytes = 0;
  let semanticBytes = 0;

  for (const absolutePath of files) {
    const source = await readFile(absolutePath, "utf8");
    const relativePath = relativePosix(root, absolutePath);
    const blocks = parseLlmnavBlocks(source, relativePath);
    const contentHash = sha256(source);
    sourceBytes += Buffer.byteLength(source);
    semanticBytes += blocks.reduce((sum, block) => sum + Buffer.byteLength(block.raw), 0);
    const imports = extractImports(source, relativePath);
    const fileRecord = {
      absolutePath,
      relativePath,
      source,
      contentHash,
      bodyHash: contentHash,
      sourceBytes: Buffer.byteLength(source),
      semanticBytes: blocks.reduce((sum, block) => sum + Buffer.byteLength(block.raw), 0),
      blocks,
      imports,
    };
    fileRecords.push(fileRecord);
    for (const block of blocks) {
      const declaration = findAttachedDeclaration(source, block, relativePath);
      records.push({
        root,
        absolutePath,
        relativePath,
        source,
        bodyHash: contentHash,
        imports,
        block,
        card: block.card,
        declaration,
      });
    }
  }

  const registry = await loadRegistry(root);
  return {
    root,
    config,
    configPath,
    files,
    fileRecords,
    records,
    registry,
    sourceBytes,
    semanticBytes,
  };
}
