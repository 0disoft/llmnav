import path from "node:path";
import { lineAtOffset, normalizeNewlines, sha256 } from "./util.js";

const DECLARATION_PATTERNS = {
  javascript: [
    { kind: "function", pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: "class", pattern: /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: "interface", pattern: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: "type", pattern: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: "variable", pattern: /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: "enum", pattern: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/u },
  ],
  go: [
    { kind: "function", pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\b/u },
    { kind: "type", pattern: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\b/u },
    { kind: "variable", pattern: /^(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/u },
  ],
  rust: [
    { kind: "function", pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/u },
    { kind: "struct", pattern: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/u },
    { kind: "enum", pattern: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/u },
    { kind: "trait", pattern: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/u },
    { kind: "impl", pattern: /^impl(?:<[^>]+>)?\s+([^\s{]+)\b/u },
  ],
  python: [
    { kind: "function", pattern: /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\b/u },
    { kind: "class", pattern: /^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/u },
  ],
  generic: [
    { kind: "class", pattern: /^(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+)*(?:class|interface|enum|struct|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\b/u },
    { kind: "function", pattern: /^(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|async\s+)*(?:[A-Za-z_][\w<>?\[\],.]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u },
  ],
};

export function findAttachedDeclaration(source, block, filePath) {
  if (block.scope !== "symbol") return null;
  const window = source.slice(block.end, block.end + 3000);
  const skipped = skipTrivia(window);
  const candidate = window.slice(skipped);
  const extension = path.extname(filePath).toLowerCase();
  const family = languageFamily(extension);
  const language = languageName(extension);
  const patterns = DECLARATION_PATTERNS[family] ?? DECLARATION_PATTERNS.generic;
  const firstLines = normalizeNewlines(candidate).split("\n").slice(0, 12).join("\n");
  const collapsed = firstLines.replace(/\s+/gu, " ").trim();

  for (const definition of patterns) {
    const match = candidate.match(definition.pattern);
    if (!match) continue;
    const declarationOffset = block.end + skipped;
    const signature = extractSignature(collapsed);
    const exported = isExportedDeclaration(language, match[1], signature);
    const endOffset = findDeclarationEnd(source, declarationOffset, family);
    return {
      symbol: match[1],
      kind: definition.kind,
      line: lineAtOffset(source, declarationOffset),
      signature,
      language,
      exported,
      visibility: exported ? "public" : language === "typescript" || language === "javascript" ? "module" : "private",
      receiver: language === "go" ? extractGoReceiver(candidate) : null,
      offset: declarationOffset,
      endOffset,
      bodyHash: sha256(normalizeNewlines(source.slice(declarationOffset, endOffset)).trimEnd()),
    };
  }
  return null;
}

function skipTrivia(value) {
  let remaining = value;
  let consumed = 0;
  for (;;) {
    const before = remaining;
    const whitespace = remaining.match(/^\s+/u)?.[0] ?? "";
    consumed += whitespace.length;
    remaining = remaining.slice(whitespace.length);

    const blockComment = remaining.match(/^\/\*(?!\s*llmnav\/)[\s\S]*?\*\//u)?.[0];
    if (blockComment) {
      consumed += blockComment.length;
      remaining = remaining.slice(blockComment.length);
      continue;
    }

    const lineComment = remaining.match(/^(?:\/\/|#|--)\s*(?!llmnav\/).*?(?:\r?\n|$)/u)?.[0];
    if (lineComment) {
      consumed += lineComment.length;
      remaining = remaining.slice(lineComment.length);
      continue;
    }

    const attribute = remaining.match(/^(?:@[A-Za-z_$][\w$]*(?:\([^\n]*\))?|#\[[^\]]+\])\s*(?:\r?\n)?/u)?.[0];
    if (attribute) {
      consumed += attribute.length;
      remaining = remaining.slice(attribute.length);
      continue;
    }

    if (remaining === before) break;
  }
  return consumed;
}

function extractSignature(collapsed) {
  if (!collapsed) return "";
  const boundaries = [collapsed.indexOf("{"), collapsed.indexOf("=>")].filter((index) => index >= 0);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : Math.min(collapsed.length, 500);
  return collapsed.slice(0, end).trim().replace(/[;:]$/u, "");
}

function languageFamily(extension) {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".astro", ".vue"].includes(extension)) {
    return "javascript";
  }
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rust";
  if (extension === ".py") return "python";
  return "generic";
}

function languageName(extension) {
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs", ".svelte", ".astro", ".vue"].includes(extension)) return "javascript";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rust";
  if (extension === ".py") return "python";
  return "generic";
}

function isExportedDeclaration(language, symbol, signature) {
  if (language === "typescript" || language === "javascript") return /^export\s+/u.test(signature);
  if (language === "go") return /^[A-Z]/u.test(symbol);
  if (language === "rust") return /^pub(?:\([^)]*\))?\s+/u.test(signature);
  if (language === "python") return !symbol.startsWith("_");
  return /^(?:public|export)\s+/u.test(signature);
}

function extractGoReceiver(candidate) {
  const match = candidate.match(/^func\s+\(([^)]*)\)\s*/u);
  if (!match) return null;
  const parts = match[1].trim().split(/\s+/u);
  return (parts.at(-1) ?? "").replace(/^\*+/u, "") || null;
}

function findDeclarationEnd(source, start, family) {
  if (family === "python") return findPythonDeclarationEnd(source, start);
  let state = "normal";
  let escaped = false;
  let regexCharacterClass = false;
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  let openedBody = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
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
    if (state !== "normal") {
      if (state === "regex") {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "[") regexCharacterClass = true;
        else if (character === "]") regexCharacterClass = false;
        else if (character === "/" && !regexCharacterClass) state = "normal";
        continue;
      }
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === state) {
        state = "normal";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (family === "javascript" && character === "/" && canStartJavaScriptRegex(source, start, index)) {
      state = "regex";
      regexCharacterClass = false;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      if (family === "rust" && character === "'" && !looksLikeRustCharacterLiteral(source, index)) continue;
      state = character;
      continue;
    }
    if (character === "(") parentheses += 1;
    if (character === ")") parentheses = Math.max(0, parentheses - 1);
    if (character === "[") brackets += 1;
    if (character === "]") brackets = Math.max(0, brackets - 1);
    if (character === "{") {
      braces += 1;
      openedBody = true;
    } else if (character === "}" && openedBody) {
      braces -= 1;
      if (braces === 0) return index + 1;
    } else if (character === ";" && !openedBody && parentheses === 0 && brackets === 0) {
      return index + 1;
    } else if (character === "\n" && !openedBody && parentheses === 0 && brackets === 0) {
      const current = source.slice(start, index).trimEnd();
      const nextCharacter = source.slice(index + 1).match(/^\s*(.)/u)?.[1] ?? "";
      if (nextCharacter !== "{" && !/(?:=>|[=|&,([{])$/u.test(current)) return index;
    }
  }
  return source.length;
}

function findPythonDeclarationEnd(source, start) {
  const declarationLineStart = source.lastIndexOf("\n", start - 1) + 1;
  const baseIndent = indentationWidth(source.slice(declarationLineStart, start));
  let cursor = source.indexOf("\n", start);
  if (cursor < 0) return source.length;
  cursor += 1;
  let bodyStarted = false;
  while (cursor < source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const end = lineEnd < 0 ? source.length : lineEnd + 1;
    const line = source.slice(cursor, lineEnd < 0 ? source.length : lineEnd);
    if (/^\s*(?:#.*)?$/u.test(line)) {
      cursor = end;
      continue;
    }
    const indent = indentationWidth(line.match(/^[ \t]*/u)?.[0] ?? "");
    if (indent > baseIndent) bodyStarted = true;
    else if (bodyStarted) return cursor;
    cursor = end;
  }
  return source.length;
}

function indentationWidth(value) {
  let width = 0;
  for (const character of value) width += character === "\t" ? 8 - (width % 8) : 1;
  return width;
}

function canStartJavaScriptRegex(source, start, offset) {
  const prefix = source.slice(start, offset).trimEnd();
  if (!prefix) return true;
  const previous = prefix.at(-1);
  if (/[=(:,!&|?{};\[]/u.test(previous)) return true;
  return /(?:^|\W)(?:case|delete|do|else|in|instanceof|new|return|throw|typeof|void|yield)\s*$/u.test(prefix);
}

function looksLikeRustCharacterLiteral(source, offset) {
  return /^'(?:\\.|[^'\\\r\n])'/u.test(source.slice(offset));
}

export function extractImports(source, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const results = new Set();
  const normalized = normalizeNewlines(source);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".astro", ".vue"].includes(extension)) {
    const patterns = [
      /^[ \t]*import\s+(?:[^;"']*?\s+from\s+)?["']([^"']+)["']/gmu,
      /^[ \t]*export\s+[^;"']*?\s+from\s+["']([^"']+)["']/gmu,
      /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/gu,
    ];
    for (const pattern of patterns) {
      for (const match of normalized.matchAll(pattern)) {
        if (match[1] && isJavaScriptCodeOffset(normalized, match.index ?? 0)) results.add(match[1]);
      }
    }
  } else if (extension === ".go") {
    for (const match of normalized.matchAll(/^[ \t]*(?:import\s+)?(?:[A-Za-z_][\w]*\s+)?"([^"]+)"/gmu)) {
      results.add(match[1]);
    }
  } else if (extension === ".rs") {
    for (const match of normalized.matchAll(/^\s*(?:use|mod)\s+([^;]+);/gmu)) results.add(match[1].trim());
  } else if (extension === ".py") {
    for (const match of normalized.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gmu)) {
      results.add(match[1] ?? match[2]);
    }
  }
  return [...results].sort();
}

function isJavaScriptCodeOffset(source, targetOffset) {
  let state = "normal";
  let escaped = false;
  for (let index = 0; index < targetOffset; index += 1) {
    const character = source[index];
    const next = source[index + 1];
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
    if (state !== "normal") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === state) state = "normal";
      continue;
    }
    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
    } else if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else if (character === '"' || character === "'" || character === "`") {
      state = character;
    }
  }
  return state === "normal";
}
