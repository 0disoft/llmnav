import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { matchesAnyGlob, relativePosix, toPosix } from "./util.js";

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

export async function collectSourceFiles(root, config, requestedPaths = []) {
  const roots = requestedPaths.length > 0 ? requestedPaths : config.sourceRoots;
  const files = new Map();
  for (const sourceRoot of roots) {
    const absolute = path.resolve(root, sourceRoot);
    assertInsideRoot(root, absolute, sourceRoot);
    try {
      const linkDetails = await lstat(absolute);
      if (linkDetails.isSymbolicLink()) throw new Error(`Source path ${JSON.stringify(sourceRoot)} is a symbolic link.`);
      const details = await stat(absolute);
      if (details.isFile()) {
        if (shouldIncludeFile(root, absolute, config)) files.set(absolute, true);
      } else if (details.isDirectory()) {
        await walkDirectory(root, absolute, config, files);
      }
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  return [...files.keys()].sort((left, right) => relativePosix(root, left).localeCompare(relativePosix(root, right)));
}

function assertInsideRoot(root, absolutePath, sourcePath) {
  const relative = path.relative(path.resolve(root), absolutePath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error(`Source path ${JSON.stringify(sourcePath)} escapes the repository root.`);
}

async function walkDirectory(root, directory, config, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = relativePosix(root, absolute);
    if (entry.isDirectory()) {
      if (config.excludeDirectories.includes(entry.name)) continue;
      if (relative.startsWith(`${toPosix(config.generation.cacheDirectory)}/`)) continue;
      await walkDirectory(root, absolute, config, files);
    } else if (entry.isFile() && shouldIncludeFile(root, absolute, config)) {
      files.set(absolute, true);
    }
  }
}

function shouldIncludeFile(root, absolutePath, config) {
  const extension = path.extname(absolutePath).toLowerCase();
  if (!config.includeExtensions.includes(extension)) return false;
  const relative = relativePosix(root, absolutePath);
  if (matchesAnyGlob(relative, config.excludeFiles)) return false;
  return true;
}
