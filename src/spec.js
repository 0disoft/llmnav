/* llmnav/1 module
id=llmnav.spec.contract
role=Define the public LLMNav/1 vocabulary, limits, relation kinds, and default configuration.
owns=protocol vocabulary|controlled field values|default configuration
excludes=configuration overrides|source parsing
search=llmnav specification|protocol constants|default config
invariant=Public field, effect, risk, and relation vocabularies remain deterministic and versioned.
rel=workflow>llmnav.config.load
rel=workflow>llmnav.rules.validate
stability=contract
*/

export const PACKAGE_VERSION = "0.7.1";
export const SPEC_VERSION = "1";

export const SCOPES = Object.freeze(["file", "module", "symbol"]);
export const STABILITIES = Object.freeze(["architecture", "contract", "implementation"]);

export const KEY_ORDER = Object.freeze([
  "id",
  "role",
  "owns",
  "excludes",
  "search",
  "invariant",
  "effect",
  "risk",
  "rel",
  "stability",
]);

export const REQUIRED_KEYS = Object.freeze(["id", "role", "stability"]);
export const REPEATABLE_KEYS = Object.freeze(["invariant", "rel"]);
export const LIST_KEYS = Object.freeze(["owns", "excludes", "search", "effect", "risk"]);
export const SCALAR_KEYS = Object.freeze(["id", "role", "stability"]);
export const ALLOWED_KEYS = Object.freeze([...KEY_ORDER]);

export const EFFECT_KINDS_WITH_ARGUMENT = Object.freeze([
  "db.read",
  "db.write",
  "cache.read",
  "cache.write",
  "event.emit",
  "event.consume",
  "net.call",
  "lock.acquire",
  "cookie.write",
  "auth.check",
]);

export const EFFECT_KINDS_WITHOUT_ARGUMENT = Object.freeze([
  "fs.read",
  "fs.write",
  "process.spawn",
  "clock.read",
  "random.read",
]);

export const EFFECT_KINDS = Object.freeze([
  ...EFFECT_KINDS_WITH_ARGUMENT,
  ...EFFECT_KINDS_WITHOUT_ARGUMENT,
]);

export const RISK_KINDS = Object.freeze([
  "auth",
  "money",
  "privacy",
  "concurrency",
  "migration",
  "availability",
  "performance",
]);

export const STRICT_RISKS = Object.freeze(["auth", "money", "privacy"]);

export const RELATION_KINDS = Object.freeze([
  "policy",
  "workflow",
  "fallback",
  "mirror",
  "migration",
  "test",
  "replaces",
  "deprecated-by",
  "cross-repo",
]);

export const FORBIDDEN_STRUCTURE_RELATIONS = Object.freeze([
  "calls",
  "imports",
  "references",
  "implements",
  "exports",
  "overrides",
]);

export const FORBIDDEN_VOLATILE_KEYS = Object.freeze([
  "path",
  "line",
  "span",
  "commit",
  "updated_at",
  "updated-at",
  "owner",
  "callers",
  "callees",
  "imports",
  "references",
  "implementation_count",
  "implementation-count",
  "test_status",
  "test-status",
  "current_signature",
  "current-signature",
]);

export const DEFAULT_INCLUDE_EXTENSIONS = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".dart",
  ".php",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".svelte",
  ".astro",
  ".vue",
]);

export const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".turbo",
  ".cache",
  ".bun-cache",
  ".pnpm-store",
  "target",
  "bin",
  "obj",
]);

export const DEFAULT_GENERIC_SEARCH_TERMS = Object.freeze([
  "service",
  "manager",
  "handler",
  "helper",
  "utility",
  "util",
  "data",
  "process",
  "logic",
  "common",
  "shared",
]);

export const DEFAULT_VAGUE_ROLE_WORDS = Object.freeze([
  "handle",
  "handles",
  "manage",
  "manages",
  "process",
  "processes",
  "utility",
  "helper",
  "service",
]);

export const ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){1,5}$/u;
export const CROSS_REPO_ID_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){1,5}$/u;

export const DEFAULT_CONFIG = Object.freeze({
  $schema: "./schema/config.schema.json",
  version: 1,
  repositoryId: "change-me",
  sourceRoots: ["."],
  includeExtensions: [...DEFAULT_INCLUDE_EXTENSIONS],
  excludeDirectories: [...DEFAULT_EXCLUDED_DIRECTORIES],
  excludeFiles: ["*.min.js", "*.bundle.js", "*.generated.*", "*.gen.*"],
  coverageRules: [],
  graph: {
    indexFiles: [],
  },
  lint: {
    maxRoleLength: 180,
    maxSearchTerms: 6,
    minSearchTerms: 2,
    maxInvariants: 4,
    maxEffects: 6,
    maxRelations: 6,
    maxBlockBytes: {
      file: 400,
      module: 1200,
      symbol: 900,
    },
    maxSemanticRatio: 0.015,
    minimumSourceBytesForRatio: 50000,
    searchTermSaturation: 0.05,
    minimumCardsForSaturation: 20,
    genericSearchTerms: [...DEFAULT_GENERIC_SEARCH_TERMS],
    vagueRoleWords: [...DEFAULT_VAGUE_ROLE_WORDS],
    strictRisks: [...STRICT_RISKS],
    additionalEffects: [],
    additionalRisks: [],
    additionalRelations: [],
    requireCanonicalOrder: true,
    requireCanonicalFormatting: true,
  },
  generation: {
    cacheDirectory: ".llmnav/cache",
    moduleDepth: 2,
    searchShardSize: 0,
    repositoryCatalogStabilities: ["architecture"],
    moduleCatalogStabilities: ["architecture", "contract"],
  },
  evaluation: {
    queryFile: ".llmnav/eval/queries.jsonl",
    minimumRecallAt1: 0.75,
    minimumRecallAt5: 0.9,
  },
});
