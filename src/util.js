import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function normalizeNewlines(value) {
  return value.replace(/\r\n?/gu, "\n");
}

export function detectNewline(value) {
  return value.includes("\r\n") ? "\r\n" : "\n";
}

export function splitPipe(value) {
  return value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function unique(values) {
  return [...new Set(values)];
}

export function stableStringify(value, space = 2) {
  return `${JSON.stringify(sortObject(value), null, space)}\n`;
}

export function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

export function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

export function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, sortObject(child)]),
    );
  }
  return value;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function toPosix(value) {
  return String(value).replace(/\\/gu, "/");
}

export function projectRelativePath(value, label = value) {
  const normalized = toPosix(value);
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`${label} must be a non-empty project-relative path.`);
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`${label} contains parent-directory traversal.`);
  }
  const canonical = path.posix.normalize(normalized).replace(/^\.\//u, "");
  if (!canonical || canonical === ".") throw new Error(`${label} must name a path below the project root.`);
  return canonical;
}

export function relativePosix(root, absolutePath) {
  return toPosix(path.relative(root, absolutePath));
}

export function lineAtOffset(source, offset) {
  return lineAtOffsetFromStarts(buildLineStarts(source), offset);
}

export function buildLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

export function lineAtOffsetFromStarts(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

export function offsetAtLine(source, targetLine) {
  if (targetLine <= 1) return 0;
  let line = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      if (line === targetLine) return index + 1;
    }
  }
  return source.length;
}

export async function readText(filePath, fallback = undefined) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (fallback !== undefined && error && typeof error === "object" && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function readJson(filePath, fallback = undefined) {
  const text = await readText(filePath, fallback === undefined ? undefined : "");
  if (text === "" && fallback !== undefined) return structuredClone(fallback);
  return JSON.parse(text);
}

export async function readJsonSafe(filePath, fallback = null) {
  try {
    return await readJson(filePath, fallback);
  } catch (error) {
    if (error instanceof SyntaxError) return structuredClone(fallback);
    throw error;
  }
}

export async function atomicWrite(root, filePath, content, options = {}) {
  const parent = path.dirname(filePath);
  const label = options.label ?? relativePosix(root, filePath);
  await assertNoSymlinkTraversal(root, filePath, label);
  await mkdir(parent, { recursive: true });
  const parentIdentity = await directoryIdentity(root, parent, label);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  try {
    await options.beforeCommit?.({ filePath, temporaryPath });
    await assertNoSymlinkTraversal(root, filePath, label);
    const currentIdentity = await directoryIdentity(root, parent, label);
    if (currentIdentity !== parentIdentity) throw new Error(`${label} parent directory changed during atomic write.`);
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (await parentHasIdentity(root, parent, parentIdentity)) await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function directoryIdentity(root, directory, label) {
  await assertNoSymlinkTraversal(root, directory, label);
  const [details, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
  if (!details.isDirectory()) throw new Error(`${label} parent is not a directory.`);
  return `${details.dev}:${details.ino}:${path.normalize(canonical)}`;
}

async function parentHasIdentity(root, parent, expected) {
  try {
    return (await directoryIdentity(root, parent, parent)) === expected;
  } catch {
    return false;
  }
}

export async function assertNoSymlinkTraversal(root, targetPath, label = targetPath) {
  const rootPath = path.resolve(root);
  const target = path.resolve(targetPath);
  const relative = path.relative(rootPath, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the repository root.`);
  }

  let current = rootPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) throw new Error(`${label} traverses symbolic link ${path.relative(rootPath, current)}.`);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return;
      throw error;
    }
  }
}

export function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? structuredClone(base) : structuredClone(override);
  }
  if (base && override && typeof base === "object" && typeof override === "object") {
    const result = structuredClone(base);
    for (const [key, value] of Object.entries(override)) {
      result[key] = key in result ? deepMerge(result[key], value) : structuredClone(value);
    }
    return result;
  }
  return override === undefined ? structuredClone(base) : structuredClone(override);
}

export function parseInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function approximateTokens(value) {
  const ascii = [...value].filter((character) => character.codePointAt(0) < 128).length;
  const nonAscii = value.length - ascii;
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.8));
}

export function truncateToTokenBudget(value, budget) {
  if (approximateTokens(value) <= budget) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (approximateTokens(value.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low).trimEnd()}\n…`;
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function globToRegExp(glob) {
  const normalized = toPosix(glob);
  let pattern = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const next = normalized[index + 1];
    if (character === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(character);
    }
  }
  pattern += "$";
  return new RegExp(pattern, "u");
}

export function matchesAnyGlob(relativePath, patterns) {
  const normalized = toPosix(relativePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function parseJsonLines(text, sourceName = "JSONL") {
  const records = [];
  const errors = [];
  for (const [index, rawLine] of normalizeNewlines(text).split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      errors.push(`${sourceName}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { records, errors };
}

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
