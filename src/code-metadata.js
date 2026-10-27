/* llmnav/1 module
id=llmnav.structure.metadata
role=Validate generated compiler metadata independently of reviewed semantic cards.
owns=common metadata contract|type origin validation
excludes=compiler execution|semantic inference|source mutation
search=generated type metadata|compiler signature contract
invariant=Metadata preserves unknown types and compiler origins without modifying semantic cards.
rel=workflow>llmnav.graph.import
stability=contract
*/

const CATEGORIES = new Set(["module", "type", "function", "method", "field", "parameter", "variable", "constant", "binding"]);
const ORIGINS = new Set(["declared", "inferred", "unknown"]);

export function normalizeCodeMetadata(value, normalizeId) {
  object(value, ["language", "category", "owner", "status", "type", "typeOrigin", "signatures", "parameters"]);
  if (!["typescript", "go"].includes(value.language)) throw new Error("metadata language must be typescript or go");
  if (!CATEGORIES.has(value.category)) throw new Error("metadata category is unsupported");
  if (!["available", "partial"].includes(value.status)) throw new Error("metadata status must be available or partial");
  type(value);
  if (!Array.isArray(value.signatures) || value.signatures.some(item => typeof item !== "string")) throw new Error("metadata signatures must be strings");
  if (!Array.isArray(value.parameters)) throw new Error("metadata parameters must be an array");
  return { language: value.language, category: value.category, owner: value.owner === null ? null : normalizeId(value.owner),
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
function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error("Invalid metadata fields");
  }
}
