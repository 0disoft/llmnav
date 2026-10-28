import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { SOURCE_LIMITS, TOKEN_ESTIMATION } from "./policy.js";
import { DEFAULT_RUNTIME } from "./runtime.js";
import { throwIfAborted } from "./abort.js";
import { runRead } from "./read-operation.js";

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

export async function readText(filePath, fallback = undefined, options = {}) {
  throwIfAborted(options.signal);
  try {
    return await runRead("read file", ({ signal }) => options.io?.readFile
      ? options.io.readFile(filePath, "utf8", { signal })
      : readFile(filePath, { encoding: "utf8", signal }), { ...options.readPolicy, signal: options.signal });
  } catch (error) {
    throwIfAborted(options.signal);
    if (fallback !== undefined && error && typeof error === "object" && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function readBytes(filePath, fallback = undefined, options = {}) {
  throwIfAborted(options.signal);
  try {
    return await runRead("read file bytes", async ({ signal }) => {
      if (options.io?.readBytes) return Buffer.from(await options.io.readBytes(filePath, { signal }));
      if (options.io?.readFile) return Buffer.from(await options.io.readFile(filePath, "utf8", { signal }), "utf8");
      return readFile(filePath, { signal });
    }, { ...options.readPolicy, signal: options.signal });
  } catch (error) {
    throwIfAborted(options.signal);
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function readJson(filePath, fallback = undefined, options = {}) {
  const text = await readText(filePath, fallback === undefined ? undefined : "", options);
  if (text === "" && fallback !== undefined) return structuredClone(fallback);
  return JSON.parse(text);
}

/** Bound native source I/O before decoding; the parser retains its decoded-byte check. */
export async function readSourceText(filePath, options = {}) {
  return runRead("read source file", async ({ signal }) => {
    if (options.io?.readFile) {
      const source = await options.io.readFile(filePath, "utf8", { signal });
      if (Buffer.byteLength(source) > SOURCE_LIMITS.maxBytes) throw sourceReadLimitError(filePath);
      return source;
    }
    const chunks = [];
    let bytes = 0;
    // Inclusive end reads one extra byte to distinguish an exact fit from overflow,
    // even if the file grows while open. Pipeline owns destruction and file closure.
    const stream = createReadStream(filePath, { end: SOURCE_LIMITS.maxBytes,
      highWaterMark: SOURCE_LIMITS.readChunkBytes });
    const closed = new Promise(resolve => stream.once("close", resolve));
    try {
      await pipeline(stream, async input => {
        for await (const chunk of input) {
          bytes += chunk.length;
          if (bytes > SOURCE_LIMITS.maxBytes) throw sourceReadLimitError(filePath);
          chunks.push(chunk);
        }
      }, { signal });
    } finally {
      if (!stream.destroyed) stream.destroy();
      await closed;
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  }, { ...options.readPolicy, signal: options.signal });
}

function sourceReadLimitError(filePath) {
  return new Error(`${filePath} exceeds the ${SOURCE_LIMITS.maxBytes}-byte source read limit.`);
}

export async function readJsonSafe(filePath, fallback = null, options = {}) {
  try {
    return await readJson(filePath, fallback, options);
  } catch (error) {
    throwIfAborted(options.signal);
    if (error instanceof SyntaxError) return structuredClone(fallback);
    throw error;
  }
}

export async function atomicWrite(root, filePath, content, options = {}) {
  const parent = path.dirname(filePath);
  const label = options.label ?? relativePosix(root, filePath);
  await assertNoSymlinkTraversal(root, filePath, label);
  const mode = await replacementPermissions(filePath);
  await mkdir(parent, { recursive: true });
  const parentIdentity = await directoryIdentity(root, parent, label);
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const temporaryPath = `${filePath}.tmp-${runtime.pid}-${runtime.randomHex(8)}`;
  let owned = false;
  try {
    const handle = await (options.io?.open ?? open)(temporaryPath, "wx", mode);
    owned = true;
    await writeFileAndClose(handle, content, { mode });
    await options.beforeCommit?.({ filePath, temporaryPath });
    await assertNoSymlinkTraversal(root, filePath, label);
    const currentIdentity = await directoryIdentity(root, parent, label);
    if (currentIdentity !== parentIdentity) throw new Error(`${label} parent directory changed during atomic write.`);
    if (options.expectedContent !== undefined && await readText(filePath, null, options) !== options.expectedContent) {
      const error = new Error(`${label} changed during atomic write. Retry against the current contents.`);
      error.code = "LLMNAV_WRITE_CONFLICT";
      throw error;
    }
    await (options.io?.rename ?? rename)(temporaryPath, filePath);
  } catch (error) {
    // A failed write can still leave a partial temporary file (ENOSPC, EIO).
    if (owned && await parentHasIdentity(root, parent, parentIdentity)) {
      try {
        await (options.io?.rm ?? rm)(temporaryPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Atomic write failed and temporary-file cleanup also failed.", { cause: error });
      }
    }
    throw error;
  }
}

async function replacementPermissions(filePath) {
  try {
    const details = await lstat(filePath);
    // Copy ordinary access bits only, never privileged set-id bits to a new inode.
    return details.isFile() ? details.mode & 0o777 : undefined;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Close an owned handle without replacing a write or sync failure. */
export async function writeFileAndClose(handle, content, { sync = false, mode } = {}) {
  const failures = [];
  try {
    await handle.writeFile(content, "utf8");
    // Creation respects umask; restore the target's exact access bits before publishing.
    if (mode !== undefined) await handle.chmod(mode);
    if (sync) await handle.sync();
  } catch (error) {
    failures.push(error);
  }
  try {
    await handle.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "File write failed and handle closure also failed.", { cause: failures[0] });
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
  let ascii = 0;
  // ASCII is one UTF-16 unit; non-ASCII keeps the existing code-unit estimate,
  // including surrogate pairs. Do not allocate arrays proportional to the text.
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 128) ascii++;
  }
  const nonAscii = value.length - ascii;
  return Math.max(1, Math.ceil(ascii / TOKEN_ESTIMATION.asciiCharactersPerToken + nonAscii / TOKEN_ESTIMATION.nonAsciiCodeUnitsPerToken));
}

const TRUNCATION_SUFFIX = "\n…";

/**
 * Trim text so the returned value, including its ellipsis, fits the budget.
 *
 * The suffix is charged against the budget instead of being appended on top of
 * it, and the cut never splits a surrogate pair.
 */
export function truncateToTokenBudget(value, budget) {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  if (approximateTokens(value) <= limit) return value;
  if (limit === 0) return "";
  const bodyBudget = Math.max(0, limit - approximateTokens(TRUNCATION_SUFFIX));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (approximateTokens(value.slice(0, middle)) <= bodyBudget) low = middle;
    else high = middle - 1;
  }
  let cut = low;
  if (cut > 0 && cut < value.length) {
    const code = value.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }
  const body = value.slice(0, cut).trimEnd();
  return `${body}${TRUNCATION_SUFFIX}`;
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Match repository-relative globs without regular-expression backtracking.
 *
 * A pattern without "/" matches a file name at any depth, so the documented
 * defaults such as "*.min.js" also cover generated bundles in subdirectories.
 * A pattern with "/" is anchored at the repository root.
 *
 * "**" spans directories only when it occupies a whole path segment; anywhere
 * else it behaves like "*" and never crosses a separator.
 */
export function matchesAnyGlob(relativePath, patterns) {
  const normalized = toPosix(relativePath);
  return patterns.some((pattern) => matchGlob(normalized, toPosix(pattern)));
}

// Simulate the glob's finite states instead of backtracking over wildcard
// partitions. Each path code point performs bounded passes over the tokens.
function matchGlob(value, pattern) {
  const tokens = globTokens(pattern);
  const anchored = pattern.includes("/");
  let active = new Uint8Array(tokens.length + 1);
  let next = new Uint8Array(tokens.length + 1);
  active[0] = 1;
  expandGlobStates(active, tokens);
  for (const character of value) {
    next.fill(0);
    if (!anchored && character === "/") next[0] = 1;
    for (let index = 0; index < tokens.length; index++) {
      if (!active[index]) continue;
      const token = tokens[index];
      if (token.kind === "star" && globCharacterMatches(token, character)) next[index] = 1;
      else if ((token.kind === "character" && token.value === character) ||
        (token.kind === "question" && character !== "/")) next[index + 1] = 1;
    }
    expandGlobStates(next, tokens);
    [active, next] = [next, active];
  }
  return active[tokens.length] === 1;
}

function globTokens(pattern) {
  const characters = [...pattern];
  const tokens = [];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (character === "*") {
      const startsSegment = index === 0 || characters[index - 1] === "/";
      const after = characters[index + 2];
      if (characters[index + 1] === "*" && startsSegment) {
        if (after === "/") {
          // The skip bypasses the entire optional .*/ group, never a suffix
          // of a consumed directory name. The star itself can exit only at /.
          tokens.push({ kind: "skipDirectory" }, { kind: "star", directories: true }, { kind: "character", value: "/" });
          index += 2;
          continue;
        }
        if (after === undefined) {
          tokens.push({ kind: "star", directories: true });
          index++;
          continue;
        }
      }
      tokens.push({ kind: "star", directories: false });
    } else if (character === "?") {
      tokens.push({ kind: "question" });
    } else {
      tokens.push({ kind: "character", value: character });
    }
  }
  return tokens;
}

function expandGlobStates(states, tokens) {
  for (let index = 0; index < tokens.length; index++) {
    if (!states[index]) continue;
    if (tokens[index].kind === "star") states[index + 1] = 1;
    else if (tokens[index].kind === "skipDirectory") {
      states[index + 1] = 1;
      states[index + 3] = 1;
    }
  }
}

function globCharacterMatches(token, character) {
  // Match the existing non-dotAll regexp semantics for **, including unusual
  // POSIX filenames containing a line terminator. * and ? still match those.
  return token.directories ? !/[\n\r\u2028\u2029]/u.test(character) : character !== "/";
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
