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
import { SOURCE_LIMITS } from "./policy.js";

const BLOCK_PATTERNS = [
  {
    style: "block",
    opening: /\/\*\s*llmnav\/1\s+(file|module|symbol)\b/giu,
    terminator: "*/",
  },
  {
    style: "html",
    opening: /<!--\s*llmnav\/1\s+(file|module|symbol)\b/giu,
    terminator: "-->",
  },
];
const MAX_SOURCE_BYTES = SOURCE_LIMITS.maxBytes;
const MAX_BLOCKS_PER_FILE = 10_000;
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);
const REGEX_PREFIX_KEYWORDS = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "return", "throw", "typeof", "void", "yield",
]);
const CONTROL_PAREN_KEYWORDS = new Set(["if", "while", "for", "with", "switch", "catch"]);

export function parseLlmnavBlocks(source, filePath = "<memory>") {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    throw new Error(`${filePath} exceeds the ${MAX_SOURCE_BYTES}-byte parser byte limit.`);
  }
  const literalMask = buildLiteralMask(source, filePath);
  const lineStarts = buildLineStarts(source);
  const commentPlacement = createCommentPlacement(source, lineStarts);
  const blockBudget = { count: 0 };
  const blocks = [];
  for (const definition of BLOCK_PATTERNS) {
    for (const match of terminatedBlockComments(source, definition)) {
      const matchStart = match.index ?? 0;
      if (literalMask[matchStart] === 1) continue;
      const { start, indent } = commentPlacement(matchStart);
      const end = match.end;
      const raw = source.slice(start, end);
      reserveBlock(blockBudget, filePath);
      blocks.push(
        createBlock({
          lineStarts,
          filePath,
          raw,
          body: match.body,
          scope: match.scope.toLowerCase(),
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
  blocks.push(...parseUnterminatedBlockComments(source, filePath, blocks, literalMask, lineStarts, blockBudget, commentPlacement));
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

// Reuse the line index and scan each line's indentation once across comment styles.
function createCommentPlacement(source, lineStarts) {
  const indentEnds = new Map();
  return offset => {
    const lineStart = lineStarts[lineAtOffsetFromStarts(lineStarts, offset) - 1];
    let indentEnd = indentEnds.get(lineStart);
    if (indentEnd === undefined) {
      indentEnd = lineStart;
      while (indentEnd < offset && /\s/u.test(source[indentEnd])) indentEnd++;
      indentEnds.set(lineStart, indentEnd);
    }
    const start = offset === indentEnd ? lineStart : offset;
    return { start, indent: start === lineStart ? source.slice(lineStart, offset) : "" };
  };
}

function* terminatedBlockComments(source, definition) {
  const opening = new RegExp(definition.opening);
  for (let match; (match = opening.exec(source)) !== null;) {
    const bodyStart = opening.lastIndex;
    const bodyEnd = source.indexOf(definition.terminator, bodyStart);
    // No later opening can close either: leave this suffix to syntax diagnostics.
    if (bodyEnd === -1) return;
    const end = bodyEnd + definition.terminator.length;
    opening.lastIndex = end;
    yield { index: match.index, end, scope: match[1], body: source.slice(bodyStart, bodyEnd) };
  }
}

function parseLineBlocks(source, filePath, literalMask, lineStarts, blockBudget) {
  const blocks = [];

  for (let index = 0; index < lineStarts.length; index += 1) {
    const line = sourceLine(source, lineStarts, index);
    const header = line.match(/^(\s*)(\/\/|#|--)\s*llmnav\/1\s+(file|module|symbol)\s*(?:\r?\n)?$/iu);
    if (!header) continue;

    const start = lineStarts[index];
    if (literalMask[start] === 1) continue;
    const indent = header[1];
    const prefix = header[2];
    const scope = header[3].toLowerCase();
    const parsed = readLineBlockBody(source, lineStarts, index, prefix);
    const end = start + parsed.length;
    const raw = source.slice(start, end);
    reserveBlock(blockBudget, filePath);
    const block = createBlock({
      lineStarts,
      filePath,
      raw,
      body: parsed.body,
      scope,
      style: "line",
      start,
      end,
      indent,
      prefix,
    });
    if (!parsed.foundEnd) {
      block.syntaxErrors.push({
        line: block.startLine,
        message: `Line-comment LLMNav blocks must end with ${prefix} /llmnav.`,
      });
    }
    blocks.push(block);

    index = parsed.nextIndex;
  }
  return blocks;
}

function sourceLine(source, lineStarts, index) {
  return source.slice(lineStarts[index], lineStarts[index + 1] ?? source.length);
}

function readLineBlockBody(source, lineStarts, index, prefix) {
  const escapedPrefix = prefix === "//" ? "\\/\\/" : prefix === "#" ? "#" : "--";
  const endPattern = new RegExp(`^\\s*${escapedPrefix}\\s*\\/llmnav\\s*(?:\\r?\\n)?$`, "iu");
  const contentPattern = new RegExp(`^\\s*${escapedPrefix}(?:\\s?)(.*?)(?:\\r?\\n)?$`, "u");
  const bodyLines = [];
  let cursor = index + 1;
  let length = sourceLine(source, lineStarts, index).length;
  let foundEnd = false;

  for (; cursor < lineStarts.length; cursor += 1) {
    const candidate = sourceLine(source, lineStarts, cursor);
    if (endPattern.test(candidate)) {
      length += candidate.length;
      foundEnd = true;
      break;
    }
    const content = candidate.match(contentPattern);
    if (!content) break;
    bodyLines.push(content[1]);
    length += candidate.length;
  }

  return {
    body: bodyLines.join("\n"),
    length,
    foundEnd,
    nextIndex: foundEnd ? cursor : Math.min(lineStarts.length - 1, Math.max(index, cursor - 1)),
  };
}

function parseUnterminatedBlockComments(source, filePath, parsedBlocks, literalMask, lineStarts, blockBudget, commentPlacement) {
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

      const { start, indent } = commentPlacement(tokenStart);
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

const LITERAL_STATE_SCANNERS = {
  "line-comment": scanLineComment,
  "block-comment": scanBlockComment,
  "html-comment": scanHtmlComment,
  "triple-single": scanTripleSingle,
  "triple-double": scanTripleDouble,
  regex: scanRegexLiteral,
  "rust-raw": scanRustRawString,
  single: scanQuotedLiteral,
  double: scanQuotedLiteral,
  backtick: scanQuotedLiteral,
};

export function buildLiteralMask(source, filePath) {
  const scan = createLiteralScan(source, filePath);
  const mask = new Uint8Array(source.length);
  for (scan.index = 0; scan.index < source.length; scan.index += 1) {
    mask[scan.index] = scan.state === "normal" ? 0 : 1;
    const scanner = LITERAL_STATE_SCANNERS[scan.state];
    if (scanner) scanner(scan);
    else scanNormalUnit(scan);
  }
  return mask;
}

function createLiteralScan(source, filePath) {
  const extension = filePath.toLowerCase().match(/\.[a-z0-9]+$/u)?.[0] ?? "";
  return {
    source,
    index: 0,
    extension,
    hashComments: [".py", ".rb", ".sh", ".bash", ".zsh"].includes(extension),
    dashComments: extension === ".sql",
    tripleQuotes: extension === ".py",
    javascript: JAVASCRIPT_EXTENSIONS.has(extension),
    regexAllowed: true,
    regexCharacterClass: false,
    previousToken: "",
    controlParentheses: [],
    expressionBraces: [],
    state: "normal",
    escaped: false,
    rustRawTerminator: "",
  };
}

function scanLineComment(scan) {
  if (scan.source[scan.index] === "\n") scan.state = "normal";
}

function scanBlockComment(scan) {
  if (scan.source[scan.index] === "*" && scan.source[scan.index + 1] === "/") {
    scan.state = "normal";
    scan.index += 1;
  }
}

function scanHtmlComment(scan) {
  if (scan.source.startsWith("-->", scan.index)) {
    scan.state = "normal";
    scan.index += 2;
  }
}

function scanTripleSingle(scan) {
  scanTripleQuote(scan, "'''");
}

function scanTripleDouble(scan) {
  scanTripleQuote(scan, '"""');
}

function scanTripleQuote(scan, terminator) {
  if (scan.source.startsWith(terminator, scan.index)) {
    scan.state = "normal";
    scan.index += 2;
  }
}

function scanRegexLiteral(scan) {
  const character = scan.source[scan.index];
  if (character === "\n" || character === "\r") {
    scan.state = "normal";
    scan.escaped = false;
  } else if (scan.escaped) scan.escaped = false;
  else if (character === "\\") scan.escaped = true;
  else if (character === "[") scan.regexCharacterClass = true;
  else if (character === "]") scan.regexCharacterClass = false;
  else if (character === "/" && !scan.regexCharacterClass) {
    scan.state = "normal";
    scan.regexAllowed = false;
    scan.previousToken = "value";
  }
}

function scanRustRawString(scan) {
  if (scan.source.startsWith(scan.rustRawTerminator, scan.index)) {
    scan.state = "normal";
    scan.index += scan.rustRawTerminator.length - 1;
  }
}

function scanQuotedLiteral(scan) {
  const character = scan.source[scan.index];
  if (scan.escaped) {
    scan.escaped = false;
    return;
  }
  if (character === "\\" && (scan.state !== "backtick" || scan.extension !== ".go")) {
    scan.escaped = true;
    return;
  }
  const terminator = scan.state === "single" ? "'" : scan.state === "double" ? '"' : "`";
  if (character === terminator) {
    scan.state = "normal";
    scan.regexAllowed = false;
    scan.previousToken = "value";
  }
}

function scanNormalUnit(scan) {
  const { source, index } = scan;
  const character = source[index];
  const next = source[index + 1];
  const rawTerminator = scan.extension === ".rs" ? rustRawStringTerminator(source, index) : null;
  if (rawTerminator !== null) {
    scan.state = "rust-raw";
    scan.rustRawTerminator = rawTerminator;
  } else if (source.startsWith("<!--", index)) {
    scan.state = "html-comment";
    scan.index += 3;
  } else if (character === "/" && next === "*") {
    scan.state = "block-comment";
    scan.index += 1;
  } else if (character === "/" && next === "/") {
    scan.state = "line-comment";
    scan.index += 1;
  } else if (scan.javascript && character === "/" && scan.regexAllowed) {
    scan.state = "regex";
    scan.regexCharacterClass = false;
    scan.escaped = false;
  } else if (scan.hashComments && character === "#") {
    scan.state = "line-comment";
  } else if (scan.dashComments && character === "-" && next === "-") {
    scan.state = "line-comment";
    scan.index += 1;
  } else if (scan.tripleQuotes && source.startsWith("'''", index)) {
    scan.state = "triple-single";
    scan.index += 2;
  } else if (scan.tripleQuotes && source.startsWith('"""', index)) {
    scan.state = "triple-double";
    scan.index += 2;
  } else if (character === "'" && (scan.extension !== ".rs" || looksLikeRustCharacterLiteral(source, index))) {
    scan.state = "single";
    scan.escaped = false;
  } else if (character === '"') {
    scan.state = "double";
    scan.escaped = false;
  } else if (character === "`") {
    scan.state = "backtick";
    scan.escaped = false;
  } else {
    scanJavaScriptToken(scan);
  }
}

function scanJavaScriptToken(scan) {
  if (!scan.javascript) return;
  const { source } = scan;
  const index = scan.index;
  const character = source[index];
  const next = source[index + 1];
  if (/\s/u.test(character)) return;
  // Track lexical expression position without rescanning prefixes. Comments do
  // not change it; a control-condition ')' permits a following regex statement.
  if (/[A-Za-z_$]/u.test(character)) {
    const start = index;
    const memberName = scan.previousToken === ".";
    while (scan.index + 1 < source.length && /[\w$]/u.test(source[scan.index + 1])) scan.index += 1;
    scan.previousToken = source.slice(start, scan.index + 1);
    scan.regexAllowed = !memberName && REGEX_PREFIX_KEYWORDS.has(scan.previousToken);
  } else if (character === "(") {
    scan.controlParentheses.push(CONTROL_PAREN_KEYWORDS.has(scan.previousToken));
    scan.regexAllowed = true;
    scan.previousToken = character;
  } else if (character === ")") {
    scan.regexAllowed = scan.controlParentheses.pop() === true;
    scan.previousToken = character;
  } else if (character === "{") {
    scan.expressionBraces.push(scan.regexAllowed && !["", ";", "else", "do", "try", "finally", ")"].includes(scan.previousToken));
    scan.regexAllowed = true;
    scan.previousToken = character;
  } else if (character === "}") {
    scan.regexAllowed = scan.expressionBraces.pop() !== true;
    scan.previousToken = character;
  } else if ((character === "+" || character === "-") && next === character) {
    scan.previousToken = character + next;
    scan.index += 1;
  } else if (character === "=" && next === ">") {
    scan.regexAllowed = true;
    scan.previousToken = "=>";
    scan.index += 1;
  } else {
    scan.regexAllowed = "=(:,!&|?;[+-*%~^>/".includes(character);
    scan.previousToken = character;
  }
}

function rustRawStringTerminator(source, index) {
  let cursor;
  if (source[index] === "r") cursor = index + 1;
  else if (source[index] === "b" && source[index + 1] === "r") cursor = index + 2;
  else return null;
  if (index > 0 && /[\p{ID_Continue}]/u.test(source[index - 1])) return null;
  let hashes = 0;
  while (source[cursor] === "#" && hashes <= 255) {
    hashes += 1;
    cursor += 1;
  }
  if (hashes > 255 || source[cursor] !== '"') return null;
  return `"${"#".repeat(hashes)}`;
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

  const parts = [];
  let cursor = 0;
  // Safe blocks retain parser order; offsets always refer to the untouched source.
  for (const block of safeBlocks) {
    const formatted = formatLlmnavBlock(block);
    if (formatted === block.raw) continue;
    parts.push(source.slice(cursor, block.start), formatted);
    cursor = block.end;
  }
  let output = source;
  if (parts.length > 0) {
    parts.push(source.slice(cursor));
    output = parts.join("");
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
