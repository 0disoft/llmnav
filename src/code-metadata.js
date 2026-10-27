/* llmnav/1 module
id=llmnav.structure.metadata
role=Validate generated compiler metadata independently of reviewed semantic cards.
owns=common metadata contract|type origin validation|bounded member pages
excludes=compiler execution|semantic inference|source mutation|semantic card validation
search=generated type metadata|compiler signature contract
invariant=Metadata preserves compiler origins and bounds detail output without modifying semantic cards or default navigation responses.
rel=workflow>llmnav.graph.import
stability=contract
*/

import { METADATA_LIMITS } from "./policy.js";
import { compareText } from "./util.js";

const metadataIndexes = new WeakMap();
const compactNodes = new WeakMap();

export function validateMetadataOptions(options) {
  for (const flag of ["metadata", "members"]) {
    if (options[flag] !== undefined && typeof options[flag] !== "boolean") throw new TypeError(`${flag} must be a boolean`);
  }
  if (options.metadata !== true && (options.members === true || ["top", "offset", "metadataBudget"].some(key => options[key] !== undefined))) {
    throw new TypeError("Metadata paging options require metadata: true");
  }
  integer(options.top ?? METADATA_LIMITS.top.default, METADATA_LIMITS.top, "top");
  integer(options.offset ?? 0, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, "offset");
  integer(options.metadataBudget ?? METADATA_LIMITS.bytes.default, METADATA_LIMITS.bytes, "metadataBudget");
}

export function withoutCodeMetadata(node) {
  if (!node || !node.definitions.some(item => item.metadata)) return node;
  if (!compactNodes.has(node)) compactNodes.set(node, { ...node, definitions: node.definitions.map(({ metadata, ...definition }) => definition) });
  return compactNodes.get(node);
}

export function codeMetadataPage(graph, key, options = {}) {
  validateMetadataOptions({ ...options, metadata: true });
  const index = metadataIndex(graph);
  const own = index.definitions.get(key) ?? [];
  const rows = options.members ? index.members.get(key) ?? [] : own;
  const offset = options.offset ?? 0, top = options.top ?? METADATA_LIMITS.top.default;
  const byteBudget = options.metadataBudget ?? METADATA_LIMITS.bytes.default;
  const base = { status: own.length ? "available" : "unavailable", scope: options.members ? "members" : "definition", byteBudget, total: rows.length, offset };
  const items = [];
  const page = () => ({ ...base, items, nextOffset: offset + items.length < rows.length ? offset + items.length : null,
    truncated: offset + items.length < rows.length || items.some(item => item.detailOmitted) });
  for (const row of rows.slice(offset, offset + top)) {
    items.push(row);
    if (bytes(page()) <= byteBudget) continue;
    items.pop();
    if (items.length) break;
    // Never split a signature or silently drop parameters: return an explicit omission.
    items.push({ id: row.id, detailOmitted: true });
    if (bytes(page()) > byteBudget) {
      items.pop();
      const result = page();
      result.requiredBytes = bytes({ ...result, items: [{ id: row.id, detailOmitted: true }] });
      return result;
    }
    break;
  }
  return page();
}

function metadataIndex(graph) {
  if (!graph) return { definitions: new Map(), members: new Map() };
  if (metadataIndexes.has(graph)) return metadataIndexes.get(graph);
  const definitions = new Map(), members = new Map();
  for (const node of graph.nodes) {
    for (const definition of node.definitions) {
      if (!definition.metadata) continue;
      const row = { id: node.key, ...definition };
      append(definitions, node.key, row);
      if (definition.metadata.owner) append(members, definition.metadata.owner, row);
    }
  }
  for (const rows of [...definitions.values(), ...members.values()]) rows.sort((a, b) => compareText(a.id, b.id) || compareText(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0));
  const index = { definitions, members };
  metadataIndexes.set(graph, index);
  return index;
}
function append(index, key, value) {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(value);
}
function bytes(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function integer(value, bounds, name) {
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) throw new RangeError(`${name} must be an integer from ${bounds.minimum} to ${bounds.maximum}`);
}

const CATEGORIES = new Set(["module", "type", "function", "method", "field", "parameter", "variable", "constant", "binding"]);
const ORIGINS = new Set(["declared", "inferred", "unknown"]);

export function normalizeCodeMetadata(value, normalizeId) {
  object(value, ["language", "category", "owner", "status", "type", "typeOrigin", "signatures", "parameters"], ["precision"]);
  if (!["typescript", "javascript", "go", "python", "rust"].includes(value.language)) throw new Error("Unsupported metadata language");
  if (value.precision !== undefined && !["syntax", "compiler"].includes(value.precision)) throw new Error("Invalid metadata precision");
  if (!CATEGORIES.has(value.category)) throw new Error("metadata category is unsupported");
  if (!["available", "partial"].includes(value.status)) throw new Error("metadata status must be available or partial");
  type(value);
  if (!Array.isArray(value.signatures) || value.signatures.some(item => typeof item !== "string")) throw new Error("metadata signatures must be strings");
  if (!Array.isArray(value.parameters)) throw new Error("metadata parameters must be an array");
  return { language: value.language, category: value.category, owner: value.owner === null ? null : normalizeId(value.owner),
    ...(value.precision ? { precision: value.precision } : {}),
    status: value.status, type: text(value.type), typeOrigin: value.typeOrigin,
    signatures: value.signatures.map(text), parameters: value.parameters.map(parameter => {
      object(parameter, ["name", "type", "typeOrigin", "optional", "variadic"]);
      type(parameter);
      if (typeof parameter.name !== "string" || typeof parameter.optional !== "boolean" || typeof parameter.variadic !== "boolean") throw new Error("Invalid metadata parameter");
      return { name: parameter.name, type: text(parameter.type), typeOrigin: parameter.typeOrigin, optional: parameter.optional, variadic: parameter.variadic };
    }) };
}

function text(value) { return value === null ? null : value.replace(/\r\n?/gu, "\n"); }
function type(value) {
  if (!ORIGINS.has(value.typeOrigin) || value.type !== null && typeof value.type !== "string" || (value.type === null) !== (value.typeOrigin === "unknown")) {
    throw new Error("metadata type must identify a declared, inferred, or unknown origin");
  }
}
function object(value, keys, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))) {
    throw new Error("Invalid metadata fields");
  }
}
