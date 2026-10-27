/* llmnav/1 module
id=llmnav.structure.rust
role=Extract conservative Rust declaration syntax with explicit limits instead of claiming compiler type resolution.
owns=Rust lexical metadata|declared parameter types|local impl ownership|syntax precision
excludes=macro expansion|crate resolution|type checking|conditional compilation
search=Rust syntax metadata|Rust impl fields|Rust function parameters
invariant=Comments, literals and macro token trees never create declarations and unresolved impl ownership remains unknown.
rel=workflow>llmnav.structure.analyze
stability=architecture
*/

import path from "node:path";
import { throwIfAborted } from "../abort.js";
import { readBytes, sha256 } from "../util.js";

export async function analyzeRust(root, files, options = {}) {
  const declarations = [], diagnostics = [], configHashes = {};
  for (const file of files) {
    throwIfAborted(options.signal);
    const relative = path.relative(root, file).split(path.sep).join("/");
    const bytes = await readBytes(file, undefined, options);
    configHashes[relative] = sha256(bytes);
    try { declarations.push(...parseRust(bytes.toString("utf8"), relative)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      diagnostics.push({ category: "Error", code: "RS_SYNTAX", path: relative, line: error.line ?? 1, message: error.message });
    }
  }
  if (diagnostics.length && !options.allowErrors) throw new Error(JSON.stringify(diagnostics));
  return { compiler: { name: "rust-lexical", version: "1" }, precision: "syntax", declarations, references: [], diagnostics, configHashes,
    limitations: ["Conservative lexical syntax, not a Rust parser or type checker: only balanced delimiters and terminated literals are validated.",
      "Macros, cfg evaluation, imports, type aliases, enum payloads, tuple fields, destructuring and call targets are not resolved. Generic bounds and names remain source text.",
      "Impl owners bind only to one same-scope local named type with a simple receiver; all metadata is partial."] };
}

function parseRust(source, file) {
  const { tokens: t, pairs } = rustTokens(source);
  const rows = [], pending = [];
  const text = (a, b) => a < b ? source.slice(t[a].start, t[b - 1].end).trim() : "";
  const identifier = token => token && /^(?:r#)?[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(token.value);
  const name = token => token.value.replace(/^r#/u, "");
  function add(symbol, index, category, owner, type = null, signatures = [], parameters = []) {
    const key = `${file}:${t[index]?.start ?? -1}:${category}:${symbol}`;
    const row = { key, symbol, path: file, offset: t[index]?.start ?? -1, line: t[index]?.line ?? 1, kind: category,
      qualified: `${owner?.qualified ?? "module"}/${category}:${symbol}`,
      ...(owner ? { parent: owner.key } : {}), metadata: { language: "rust", precision: "syntax", category, owner: owner?.key ?? null,
        status: "partial", type, typeOrigin: type === null ? "unknown" : "declared", signatures, parameters } };
    rows.push(row); return row;
  }
  const module = add(path.basename(file), -1, "module", null);
  module.qualified = "module";
  // Generic commas do not split fields or callable parameters.
  function find(start, end, values) {
    let angle = 0;
    for (let i = start; i < end; i++) {
      const value = t[i].value;
      if (!angle && values.has(value)) return i;
      if (pairs.has(i)) { i = pairs.get(i); continue; }
      if (value === "<") angle++;
      else if (value === ">" && angle) angle--;
    }
    return end;
  }
  function segments(start, end) {
    const result = [];
    while (start < end) {
      const next = find(start, end, new Set([","]));
      if (start < next) result.push([start, next]);
      start = next + 1;
    }
    return result;
  }
  function fields(start, end, owner) {
    for (const [a, b] of segments(start, end)) {
      const colon = find(a, b, new Set([":"]));
      if (colon === b || !identifier(t[colon - 1])) continue;
      add(name(t[colon - 1]), colon - 1, "field", owner, text(colon + 1, b) || null);
    }
  }
  function walk(start, end, owner, receiver = null) {
    for (let i = start; i < end; i++) {
      const word = t[i].value;
      if (word === "!" && t[i + 1]) {
        const group = pairs.has(i + 1) ? i + 1 : pairs.has(i + 2) ? i + 2 : null;
        if (group !== null) { i = pairs.get(group); continue; }
      }
      if (word === "#") {
        const group = t[i + 1]?.value === "!" ? i + 2 : i + 1;
        if (pairs.has(group)) { i = pairs.get(group); continue; }
      }
      if (word === "impl") {
        const body = find(i + 1, end, new Set(["{", ";"]));
        if (t[body]?.value !== "{") continue;
        const header = text(i + 1, body);
        // Complex/generic or qualified receivers remain unresolved, avoiding invented ownership.
        const match = header.match(/^(?:[\p{ID_Start}_][\p{ID_Continue}]*\s+for\s+)?([\p{ID_Start}_][\p{ID_Continue}]*)$/u);
        walk(body + 1, pairs.get(body), owner, { name: match?.[1] ?? null, scope: owner.key, label: header });
        i = pairs.get(body); continue;
      }
      if (word === "fn" && identifier(t[i + 1])) {
        const open = find(i + 2, end, new Set(["(", ";", "{"]));
        if (t[open]?.value !== "(") continue;
        const close = pairs.get(open);
        const body = find(close + 1, end, new Set(["{", ";"]));
        if (body === end) continue;
        const parameters = [], locations = [];
        for (const [a, b] of segments(open + 1, close)) {
          const colon = find(a, b, new Set([":"]));
          const selfIndex = colon === b ? t.slice(a, b).findIndex(token => token.value === "self") : -1;
          const self = selfIndex >= 0;
          const at = self ? a + selfIndex : colon - 1;
          if (!identifier(t[at])) continue;
          const type = self ? text(a, b).replace(/\bself\b/u, "Self") : text(colon + 1, b) || null;
          parameters.push({ name: name(t[at]), type, typeOrigin: type ? "declared" : "unknown", optional: false, variadic: false });
          locations.push(at);
        }
        const arrow = find(close + 1, body, new Set(["->"]));
        const where = find(arrow + 1, body, new Set(["where"]));
        const row = add(name(t[i + 1]), i, receiver || owner.kind === "type" ? "method" : "function", owner,
          arrow < body ? text(arrow + 1, where) || null : null, [text(i, body)], parameters);
        if (receiver) { pending.push({ row, receiver }); row.qualified += `/impl:${receiver.label}`; }
        else if (owner.kind === "type") row.display = `${owner.symbol}.${row.symbol}`;
        parameters.forEach((parameter, index) => add(parameter.name, locations[index], "parameter", row, parameter.type));
        i = t[body].value === "{" ? pairs.get(body) : body;
        continue;
      }
      if (["struct", "enum", "trait", "mod"].includes(word) && identifier(t[i + 1])) {
        const body = find(i + 2, end, new Set(["{", ";", "("]));
        const row = add(name(t[i + 1]), i, word === "mod" ? "module" : "type", owner, null, [text(i, body)]);
        if (t[body]?.value === "{") {
          if (word === "struct") fields(body + 1, pairs.get(body), row);
          else if (word !== "enum") walk(body + 1, pairs.get(body), row);
        }
        i = pairs.get(body) ?? body;
      } else if (pairs.has(i)) i = pairs.get(i);
    }
  }
  walk(0, t.length, module);
  const types = new Map();
  for (const row of rows) if (row.kind === "type") {
    const key = `${row.parent}:${row.symbol}`;
    const found = types.get(key); types.set(key, found === undefined ? row : null);
  }
  for (const { row, receiver } of pending) {
    const owner = receiver.name && types.get(`${receiver.scope}:${receiver.name}`);
    if (owner) { row.parent = owner.key; row.metadata.owner = owner.key; row.display = `${owner.symbol}.${row.symbol}`; }
    else { delete row.parent; row.metadata.owner = null; }
  }
  return rows;
}

function rustTokens(source) {
  const tokens = [], pairs = new Map(), stack = [];
  const opens = new Set(["(", "[", "{"]), closes = { ")": "(", "]": "[", "}": "{" };
  const word = /(?:r#)?[\p{ID_Start}_][\p{ID_Continue}]*/uy;
  let i = 0, line = 1;
  const fail = message => { throw Object.assign(new SyntaxError(message), { line }); };
  function skip(end) { if (end < 0) fail("Unterminated Rust comment or literal"); for (; i < end; i++) if (source[i] === "\n") line++; }
  while (i < source.length) {
    if (/\s/u.test(source[i])) { if (source[i++] === "\n") line++; continue; }
    if (source.startsWith("//", i)) { const end = source.indexOf("\n", i); skip(end < 0 ? source.length : end); continue; }
    if (source.startsWith("/*", i)) {
      let depth = 1, end = i + 2;
      for (; end < source.length && depth; end++) {
        if (source.startsWith("/*", end)) { depth++; end++; }
        else if (source.startsWith("*/", end)) { depth--; end++; }
      }
      if (depth) fail("Unterminated Rust block comment");
      skip(end); continue;
    }
    const raw = source.slice(i, i + 260).match(/^(?:br|cr|r)(#{0,255})"/u);
    if (raw) { const terminator = `"${raw[1]}`; const end = source.indexOf(terminator, i + raw[0].length); skip(end < 0 ? -1 : end + terminator.length); continue; }
    if (source[i] === '"') {
      let end = i + 1;
      for (; end < source.length && source[end] !== '"'; end++) if (source[end] === "\\") end++;
      skip(end < source.length ? end + 1 : -1); continue;
    }
    const char = source[i] === "'" && source.slice(i, i + 20).match(/^'(?:\\(?:u\{[0-9a-fA-F_]+\}|.)|[^'\\\r\n])'/u);
    if (char) { skip(i + char[0].length); continue; }
    const start = i, tokenLine = line;
    word.lastIndex = i;
    const match = word.exec(source);
    const value = match?.[0] ?? (source.startsWith("->", i) || source.startsWith("::", i) ? source.slice(i, i + 2) : source[i]);
    i += value.length;
    const index = tokens.length;
    tokens.push({ value, start, end: i, line: tokenLine });
    if (opens.has(value)) stack.push(index);
    else if (Object.hasOwn(closes, value)) {
      const open = stack.pop();
      if (open === undefined || tokens[open].value !== closes[value]) fail("Unbalanced Rust delimiters");
      pairs.set(open, index);
    }
  }
  if (stack.length) fail("Unclosed Rust delimiter");
  return { tokens, pairs };
}
