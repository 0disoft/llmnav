/* llmnav/1 module
id=llmnav.syntax.parse
role=Parse LLMNav source comments into deterministic semantic cards and rewrite them canonically.
owns=comment grammar|card materialization|canonical serialization
excludes=semantic validation|repository search
search=llmnav parser|comment grammar|canonical formatting
stability=architecture
*/

import {
  KEY_ORDER,
  LIST_KEYS,
  REPEATABLE_KEYS,
  SCALAR_KEYS,
  SCOPES,
  SPEC_VERSION,
} from "./spec.js";
import {
  buildLineStarts,
  detectNewline,
  lineAtOffsetFromStarts,
  normalizeNewlines,
  splitPipe,
} from "./util.js";

const BLOCK_PATTERNS = [
  {
    style: "block",
    pattern: /\/\*\s*llmnav\/1\s+(file|module|symbol)\b([\s\S]*?)\*\//giu,
    opening: /\/\*\s*llmnav\/1\s+(file|module|symbol)\b/giu,
    terminator: "*/",
  },
  {
    style: "html",
    pattern: /<!--\s*llmnav\/1\s+(file|module|symbol)\b([\s\S]*?)-->/giu,
    opening: /<!--\s*llmnav\/1\s+(file|module|symbol)\b/giu,
    terminator: "-->",
  },
];
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_BLOCKS_PER_FILE = 10_000;

export function parseLlmnavBlocks(source, filePath = "<memory>") {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    throw new Error(`${filePath} exceeds the ${MAX_SOURCE_BYTES}-byte parser byte limit.`);
  }
  const literalMask = buildLiteralMask(source, filePath);
  const lineStarts = buildLineStarts(source);
  const blockBudget = { count: 0 };
  const blocks = [];
  for (const definition of BLOCK_PATTERNS) {
    definition.pattern.lastIndex = 0;
    for (const match of source.matchAll(definition.pattern)) {
      const matchedRaw = match[0];
      const matchStart = match.index ?? 0;
      if (literalMask[matchStart] === 1) continue;
      const lineStart = source.lastIndexOf("\n", matchStart - 1) + 1;
      const leading = source.slice(lineStart, matchStart);
      const start = /^\s*$/u.test(leading) ? lineStart : matchStart;
      const end = matchStart + matchedRaw.length;
      const indent = start === lineStart ? leading : "";
      const raw = source.slice(start, end);
      reserveBlock(blockBudget, filePath);
      blocks.push(
        createBlock({
          lineStarts,
          filePath,
          raw,
          body: match[2],
          scope: match[1].toLowerCase(),
          style: definition.style,
          start,
          end,
          indent,
          prefix: null,
        }),
      );
    }
  }

  blocks.push(...parseLineBlocks(source, filePath, literalMask, lineStarts, blockBudget));
  blocks.push(...parseUnterminatedBlockComments(source, filePath, blocks, literalMask, lineStarts, blockBudget));
  blocks.sort((left, right) => left.start - right.start);

  const overlapping = [];
  let previousEnd = -1;
  for (const block of blocks) {
    if (block.start < previousEnd) overlapping.push(block);
    previousEnd = Math.max(previousEnd, block.end);
  }
  if (overlapping.length > 0) {
    for (const block of overlapping) {
      block.syntaxErrors.push({
        line: block.startLine,
        message: "LLMNav blocks overlap; use one comment style per card.",
      });
    }
  }

  return blocks;
}

function parseLineBlocks(source, filePath, literalMask, lineStarts, blockBudget) {
  const blocks = [];
  const lines = source.split(/(?<=\n)/u);
  const offsets = [];
  let runningOffset = 0;
  for (const line of lines) {
    offsets.push(runningOffset);
    runningOffset += line.length;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = line.match(/^(\s*)(\/\/|#|--)\s*llmnav\/1\s+(file|module|symbol)\s*(?:\r?\n)?$/iu);
    if (!header) continue;

    const start = offsets[index];
    if (literalMask[start] === 1) continue;
    const indent = header[1];
    const prefix = header[2];
    const scope = header[3].toLowerCase();
    const escapedPrefix = prefix === "//" ? "\\/\\/" : prefix === "#" ? "#" : "--";
    const endPattern = new RegExp(`^\\s*${escapedPrefix}\\s*\\/llmnav\\s*(?:\\r?\\n)?$`, "iu");
    const contentPattern = new RegExp(`^\\s*${escapedPrefix}(?:\\s?)(.*?)(?:\\r?\\n)?$`, "u");
    const bodyLines = [];
    let cursor = index + 1;
    let end = start + line.length;
    let foundEnd = false;

    for (; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (endPattern.test(candidate)) {
        end += candidate.length;
        foundEnd = true;
        break;
      }
      const content = candidate.match(contentPattern);
      if (!content) break;
      bodyLines.push(content[1]);
      end += candidate.length;
    }

    const raw = source.slice(start, end);
    reserveBlock(blockBudget, filePath);
    const block = createBlock({
      lineStarts,
      filePath,
      raw,
      body: bodyLines.join("\n"),
      scope,
      style: "line",
      start,
      end,
      indent,
      prefix,
    });
    if (!foundEnd) {
      block.syntaxErrors.push({
        line: block.startLine,
        message: `Line-comment LLMNav blocks must end with ${prefix} /llmnav.`,
      });
    }
    blocks.push(block);

    if (foundEnd) index = cursor;
    else if (cursor >= lines.length) index = lines.length - 1;
    else index = Math.max(index, cursor - 1);
  }
  return blocks;
}

function parseUnterminatedBlockComments(source, filePath, parsedBlocks, literalMask, lineStarts, blockBudget) {
  const blocks = [];
  const parsedIntervals = [...parsedBlocks].sort((left, right) => left.start - right.start);
  for (const definition of BLOCK_PATTERNS) {
    let intervalIndex = 0;
    definition.opening.lastIndex = 0;
    for (const match of source.matchAll(definition.opening)) {
      const tokenStart = match.index ?? 0;
      if (literalMask[tokenStart] === 1) continue;
      while (parsedIntervals[intervalIndex]?.end <= tokenStart) intervalIndex += 1;
      const interval = parsedIntervals[intervalIndex];
      if (interval && tokenStart >= interval.start && tokenStart < interval.end) continue;
      const bodyStart = tokenStart + match[0].length;

      const lineStart = source.lastIndexOf("\n", tokenStart - 1) + 1;
      const leading = source.slice(lineStart, tokenStart);
      const start = /^\s*$/u.test(leading) ? lineStart : tokenStart;
      const indent = start === lineStart ? leading : "";
      const end = source.length;
      reserveBlock(blockBudget, filePath);
      const block = createBlock({
        lineStarts,
        filePath,
        raw: source.slice(start, end),
        body: source.slice(bodyStart),
        scope: match[1].toLowerCase(),
        style: definition.style,
        start,
        end,
        indent,
        prefix: null,
      });
      block.syntaxErrors.push({
        line: block.startLine,
        message: `${definition.style === "html" ? "HTML-comment" : "Block-comment"} LLMNav blocks must end with ${definition.terminator}.`,
      });
      blocks.push(block);
    }
  }
  return blocks;
}

function buildLiteralMask(source, filePath) {
  const extension = filePath.toLowerCase().match(/\.[a-z0-9]+$/u)?.[0] ?? "";
  const hashComments = [".py", ".rb", ".sh", ".bash", ".zsh"].includes(extension);
  const dashComments = extension === ".sql";
  const tripleQuotes = extension === ".py";
  let state = "normal";
  let escaped = false;
  const mask = new Uint8Array(source.length);

  for (let index = 0; index < source.length; index += 1) {
    mask[index] = state === "normal" ? 0 : 1;
    const character = source[index];
    const next = source[index + 1];
    const nextTwo = source.slice(index, index + 3);
    const nextFour = source.slice(index, index + 4);

    if (state === "line-comment") {
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "html-comment") {
      if (source.slice(index, index + 3) === "-->") {
        state = "normal";
        index += 2;
      }
      continue;
    }
    if (state === "triple-single") {
      if (nextTwo === "'''") {
        state = "normal";
        index += 2;
      }
      continue;
    }
    if (state === "triple-double") {
      if (nextTwo === '"""') {
        state = "normal";
        index += 2;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "backtick") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      const terminator = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (character === terminator) state = "normal";
      continue;
    }

    if (nextFour === "<!--") {
      state = "html-comment";
      index += 3;
    } else if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
    } else if (hashComments && character === "#") {
      state = "line-comment";
    } else if (dashComments && character === "-" && next === "-") {
      state = "line-comment";
      index += 1;
    } else if (tripleQuotes && nextTwo === "'''") {
      state = "triple-single";
      index += 2;
    } else if (tripleQuotes && nextTwo === '"""') {
      state = "triple-double";
      index += 2;
    } else if (character === "'" && (extension !== ".rs" || looksLikeRustCharacterLiteral(source, index))) {
      state = "single";
      escaped = false;
    } else if (character === '"') {
      state = "double";
      escaped = false;
    } else if (character === "`") {
      state = "backtick";
      escaped = false;
    }
  }

  return mask;
}

function looksLikeRustCharacterLiteral(source, offset) {
  return /^'(?:\\.|[^'\\\r\n])'/u.test(source.slice(offset));
}

function reserveBlock(blockBudget, filePath) {
  blockBudget.count += 1;
  if (blockBudget.count > MAX_BLOCKS_PER_FILE) {
    throw new Error(`${filePath} exceeds the ${MAX_BLOCKS_PER_FILE}-block parser limit.`);
  }
}

function createBlock({ lineStarts, filePath, raw, body, scope, style, start, end, indent, prefix }) {
  const startLine = lineAtOffsetFromStarts(lineStarts, start);
  const bodyStartLine = style === "line" ? startLine + 1 : startLine;
  const parsed = parseBody(body, bodyStartLine);
  const card = materializeCard(scope, parsed.entries);
  return {
    specVersion: SPEC_VERSION,
    filePath,
    scope,
    card,
    entries: parsed.entries,
    syntaxErrors: parsed.errors,
    style,
    prefix,
    indent,
    raw,
    start,
    end,
    startLine,
    endLine: lineAtOffsetFromStarts(lineStarts, Math.max(start, end - 1)),
    newline: detectNewline(raw),
  };
}

function parseBody(body, startLine) {
  const entries = [];
  const errors = [];
  const normalized = normalizeNewlines(body);
  for (const [index, originalLine] of normalized.split("\n").entries()) {
    const cleaned = originalLine.replace(/^\s*\*?\s?/u, "").trimEnd();
    if (!cleaned.trim()) continue;
    const match = cleaned.match(/^([a-z][a-z0-9_-]*)=(.*)$/u);
    if (!match) {
      errors.push({
        line: startLine + index,
        message: `Expected key=value, received ${JSON.stringify(cleaned.trim())}.`,
      });
      continue;
    }
    entries.push({
      key: match[1],
      value: match[2].trim(),
      line: startLine + index,
      order: entries.length,
    });
  }
  return { entries, errors };
}

function materializeCard(scope, entries) {
  const card = {
    scope,
    id: "",
    role: "",
    owns: [],
    excludes: [],
    search: [],
    invariant: [],
    effect: [],
    risk: [],
    rel: [],
    stability: "",
    unknown: [],
  };

  for (const entry of entries) {
    if (SCALAR_KEYS.includes(entry.key)) {
      card[entry.key] = entry.value;
    } else if (LIST_KEYS.includes(entry.key)) {
      card[entry.key].push(...splitPipe(entry.value));
    } else if (REPEATABLE_KEYS.includes(entry.key)) {
      card[entry.key].push(entry.value);
    } else {
      card.unknown.push({ key: entry.key, value: entry.value, line: entry.line });
    }
  }
  return card;
}

export function formatLlmnavBlock(block) {
  if (!SCOPES.includes(block.scope)) throw new Error(`Unknown LLMNav scope: ${block.scope}`);
  const lines = [];
  for (const key of KEY_ORDER) {
    const value = block.card[key];
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (REPEATABLE_KEYS.includes(key)) {
        for (const item of value) lines.push(`${key}=${item.trim()}`);
      } else {
        lines.push(`${key}=${value.map((item) => item.trim()).filter(Boolean).join("|")}`);
      }
    } else if (typeof value === "string" && value.trim()) {
      lines.push(`${key}=${value.trim()}`);
    }
  }

  const newline = block.newline ?? "\n";
  const indent = block.indent ?? "";
  if (block.style === "html") {
    return `${indent}<!-- llmnav/1 ${block.scope}${newline}${lines.map((line) => `${indent}${line}`).join(newline)}${newline}${indent}-->`;
  }
  if (block.style === "line") {
    const prefix = block.prefix ?? "//";
    const trailingNewline = block.raw.endsWith("\r\n") ? "\r\n" : block.raw.endsWith("\n") ? "\n" : "";
    return `${indent}${prefix} llmnav/1 ${block.scope}${newline}${lines
      .map((line) => `${indent}${prefix} ${line}`)
      .join(newline)}${newline}${indent}${prefix} /llmnav${trailingNewline}`;
  }
  return `${indent}/* llmnav/1 ${block.scope}${newline}${lines.map((line) => `${indent}${line}`).join(newline)}${newline}${indent}*/`;
}

export function canonicalizeSource(source, filePath = "<memory>") {
  const blocks = parseLlmnavBlocks(source, filePath);
  if (blocks.length === 0) return { source, changed: false, blocks, errors: [] };
  const errors = [];
  const safeBlocks = [];
  for (const block of blocks) {
    const blockErrors = [];
    for (const syntaxError of block.syntaxErrors) {
      blockErrors.push({ line: syntaxError.line, message: syntaxError.message });
    }
    for (const unknown of block.card.unknown) {
      blockErrors.push({ line: unknown.line, message: `Unknown field ${unknown.key} must be fixed before formatting.` });
    }
    const scalarCounts = new Map();
    for (const entry of block.entries.filter((entry) => SCALAR_KEYS.includes(entry.key))) {
      scalarCounts.set(entry.key, (scalarCounts.get(entry.key) ?? 0) + 1);
    }
    for (const [key, count] of scalarCounts) {
      if (count > 1) blockErrors.push({ line: block.startLine, message: `Duplicate scalar field ${key} must be fixed before formatting.` });
    }
    errors.push(...blockErrors);
    if (blockErrors.length > 0) continue;
    safeBlocks.push(block);
  }

  let output = source;
  for (const block of [...safeBlocks].sort((left, right) => right.start - left.start)) {
    const formatted = formatLlmnavBlock(block);
    output = `${output.slice(0, block.start)}${formatted}${output.slice(block.end)}`;
  }
  return { source: output, changed: output !== source, blocks, errors };
}

export function cardToCanonicalObject(card) {
  const result = { scope: card.scope };
  for (const key of KEY_ORDER) {
    const value = card[key];
    if (Array.isArray(value)) {
      if (value.length > 0) result[key] = [...value];
    } else if (value) {
      result[key] = value;
    }
  }
  return result;
}
