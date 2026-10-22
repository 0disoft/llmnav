/* llmnav/1 module
id=llmnav.source.discover
role=Locate ancestor LLMNav roots and collect project-contained source files without following symlinks.
owns=project root discovery|source traversal|include and exclude filtering
excludes=source parsing|generated artifact selection
search=source discovery|project root|file traversal
invariant=Selected source paths remain inside the repository and symbolic links are never traversed.
rel=workflow>llmnav.project.scan
stability=contract
*/

import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { throwIfAborted } from "./abort.js";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { compareText, matchesAnyGlob, relativePosix, toPosix } from "./util.js";

const INTERNAL_DIRECTORIES = [".llmnav/tmp", ".llmnav/state", ".llmnav/.transactions"];

export async function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  let fallback = null;
  for (;;) {
    if (await pathExists(path.join(current, ".llmnav"))) return current;
    if (fallback === null) {
      if ((await pathExists(path.join(current, "package.json"))) || (await pathExists(path.join(current, ".git")))) {
        fallback = current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return fallback ?? path.resolve(start);
    current = parent;
  }
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function collectSourceFiles(root, config, requestedPaths = [], options = {}) {
  throwIfAborted(options.signal);
  const roots = requestedPaths.length > 0 ? requestedPaths : config.sourceRoots;
  const files = new Map();
  for (const sourceRoot of roots) {
    throwIfAborted(options.signal);
    const absolute = path.resolve(root, sourceRoot);
    assertInsideRoot(root, absolute, sourceRoot);
    if (isInternalPath(root, absolute, config)) continue;
    try {
      const linkDetails = await lstat(absolute);
      if (linkDetails.isSymbolicLink()) throw new Error(`Source path ${JSON.stringify(sourceRoot)} is a symbolic link.`);
      const details = await stat(absolute);
      if (details.isFile()) {
        if (shouldIncludeFile(root, absolute, config)) files.set(absolute, true);
      } else if (details.isDirectory()) {
        await walkDirectory(root, absolute, config, files, {
          signal: options.signal,
          ioConcurrency: options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY,
        });
      }
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  return [...files.keys()].sort((left, right) => compareText(relativePosix(root, left), relativePosix(root, right)));
}

function assertInsideRoot(root, absolutePath, sourcePath) {
  const relative = path.relative(path.resolve(root), absolutePath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error(`Source path ${JSON.stringify(sourcePath)} escapes the repository root.`);
}

async function walkDirectory(root, directory, config, files, options) {
  let pending = [directory];
  while (pending.length > 0) {
    throwIfAborted(options.signal);
    const batches = await mapWithConcurrency(pending, options.ioConcurrency, (current) =>
      readDirectory(root, current, config, options.signal), { signal: options.signal });
    const next = [];
    for (const batch of batches) {
      for (const absolute of batch.files) files.set(absolute, true);
      next.push(...batch.directories);
    }
    next.sort(compareText);
    pending = next;
  }
}

async function readDirectory(root, directory, config, signal) {
  throwIfAborted(signal);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  const batch = { files: [], directories: [] };
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (config.excludeDirectories.includes(entry.name)) continue;
      if (isInternalPath(root, absolute, config)) continue;
      batch.directories.push(absolute);
    } else if (entry.isFile() && shouldIncludeFile(root, absolute, config)) {
      batch.files.push(absolute);
    }
  }
  return batch;
}

function shouldIncludeFile(root, absolutePath, config) {
  if (isInternalPath(root, absolutePath, config)) return false;
  const extension = path.extname(absolutePath).toLowerCase();
  if (!config.includeExtensions.includes(extension)) return false;
  const relative = relativePosix(root, absolutePath);
  if (matchesAnyGlob(relative, config.excludeFiles)) return false;
  return true;
}

function isInternalPath(root, absolutePath, config) {
  const relative = relativePosix(root, absolutePath);
  const cache = toPosix(config.generation.cacheDirectory).replace(/\/+$/u, "");
  return [cache, ...INTERNAL_DIRECTORIES].some(directory => relative === directory || relative.startsWith(`${directory}/`));
}
