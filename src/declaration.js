import path from "node:path";
import { lineAtOffset, normalizeNewlines } from "./util.js";

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
  const family = languageFamily(path.extname(filePath).toLowerCase());
  const patterns = DECLARATION_PATTERNS[family] ?? DECLARATION_PATTERNS.generic;
  const firstLines = normalizeNewlines(candidate).split("\n").slice(0, 12).join("\n");
  const collapsed = firstLines.replace(/\s+/gu, " ").trim();

  for (const definition of patterns) {
    const match = candidate.match(definition.pattern);
    if (!match) continue;
    const declarationOffset = block.end + skipped;
    return {
      symbol: match[1],
      kind: definition.kind,
      line: lineAtOffset(source, declarationOffset),
      signature: extractSignature(collapsed),
      offset: declarationOffset,
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

export function extractImports(source, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const results = new Set();
  const normalized = normalizeNewlines(source);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".astro", ".vue"].includes(extension)) {
    for (const match of normalized.matchAll(/(?:import[\s\S]*?from\s*|import\s*|require\s*\()?["']([^"']+)["']/gu)) {
      if (match[1]) results.add(match[1]);
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
