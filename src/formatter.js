/* llmnav/1 module
id=llmnav.source.format
role=Canonicalize LLMNav source blocks across selected files with atomic writes and check-only reporting.
owns=source card formatting|format check mode|atomic source rewrite
excludes=semantic validation|generated cache formatting
search=llmnav format|canonical comments|source rewrite
invariant=Check mode reports non-canonical files without writing source files.
rel=workflow>llmnav.syntax.parse
stability=contract
*/

import { loadConfig } from "./config.js";
import { collectSourceFiles } from "./files.js";
import { canonicalizeSource } from "./parser.js";
import { atomicWrite, readSourceText, relativePosix } from "./util.js";
import { withGenerationLock } from "./transaction.js";

export async function formatProject(root, options = {}) {
  if (options.check) return formatProjectLocked(root, options);
  return withGenerationLock(root, () => formatProjectLocked(root, options), options.lockOptions);
}

async function formatProjectLocked(root, options) {
  const { config } = await loadConfig(root);
  const files = await collectSourceFiles(root, config, options.paths ?? []);
  const changedFiles = [];
  const errors = [];
  for (const filePath of files) {
    const source = await readSourceText(filePath);
    const relativePath = relativePosix(root, filePath);
    const result = canonicalizeSource(source, relativePath);
    errors.push(...result.errors.map((error) => ({ file: relativePath, ...error })));
    if (!result.changed) continue;
    changedFiles.push(relativePath);
    if (!options.check) {
      await atomicWrite(root, filePath, result.source, { ...options.atomicWriteOptions, expectedContent: source });
    }
  }
  const ok = errors.length === 0 && (options.check ? changedFiles.length === 0 : true);
  return { ok, changedFiles, errors };
}
