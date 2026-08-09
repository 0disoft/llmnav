import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { collectSourceFiles } from "./files.js";
import { canonicalizeSource } from "./parser.js";
import { atomicWrite, relativePosix } from "./util.js";

export async function formatProject(root, options = {}) {
  const { config } = await loadConfig(root);
  const files = await collectSourceFiles(root, config, options.paths ?? []);
  const changedFiles = [];
  const errors = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const relativePath = relativePosix(root, filePath);
    const result = canonicalizeSource(source, relativePath);
    errors.push(...result.errors.map((error) => ({ file: relativePath, ...error })));
    if (!result.changed) continue;
    changedFiles.push(relativePath);
    if (!options.check) await atomicWrite(filePath, result.source);
  }
  const ok = errors.length === 0 && (options.check ? changedFiles.length === 0 : true);
  return { ok, changedFiles, errors };
}
