/* llmnav/1 module
id=llmnav.audit.coverage
role=Identify high-value source modules that lack semantic navigation boundaries without modifying source.
owns=annotation coverage audit|candidate prioritization|coverage rule suggestions
excludes=automatic source annotation|semantic role generation
search=llmnav audit|missing module cards|coverage suggestions
invariant=Audit output is deterministic, repository-relative, and advisory unless an explicit fail threshold is selected.
rel=workflow>llmnav.project.scan
stability=contract
*/

import path from "node:path";
import { detectBoundaries } from "./boundaries.js";
import { scanProject } from "./project.js";
import { compareText, readJsonSafe, toPosix } from "./util.js";

export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_PRIORITIES = Object.freeze(["high", "medium", "low"]);

const SOURCE_EXTENSIONS = Object.freeze([
  ".astro", ".c", ".cc", ".cjs", ".cpp", ".cs", ".cts", ".dart", ".go", ".h", ".hpp", ".java",
  ".js", ".jsx", ".kt", ".kts", ".mjs", ".mts", ".php", ".py", ".rb", ".rs", ".svelte", ".swift",
  ".ts", ".tsx", ".vue",
]);
const UTILITY_NAME_PATTERN = /^(?:common|helpers?|shared|utils?)$/u;
const NON_PRODUCTION_PATH_PATTERN = /(?:^|\/)(?:__tests__|benchmarks?|fixtures?|tests?)(?:\/|$)|\.(?:spec|test)\.[^/]+$/u;
const LARGE_SOURCE_BYTES = 12_000;

export async function auditProject(root) {
  const project = await scanProject(root);
  const fileByPath = new Map(
    project.fileRecords.map((record) => [toPosix(record.relativePath), record]),
  );
  const moduleCardPaths = new Set(
    project.records
      .filter((record) => record.card.scope === "file" || record.card.scope === "module")
      .map((record) => toPosix(record.relativePath)),
  );
  const importsByPath = new Map();
  const importedBy = new Map([...fileByPath.keys()].map((file) => [file, new Set()]));
  for (const [file, record] of fileByPath) {
    const resolved = record.imports
      .map((specifier) => resolveLocalSpecifier(file, specifier, fileByPath))
      .filter(Boolean);
    const unique = [...new Set(resolved)].sort(compareText);
    importsByPath.set(file, unique);
    for (const target of unique) importedBy.get(target)?.add(file);
  }

  const packageJson = await readJsonSafe(path.join(root, "package.json"), {});
  const entrypoints = collectPackageEntrypoints(packageJson, fileByPath);
  const publicApiPaths = collectPublicApiPaths(entrypoints, fileByPath);
  const candidates = [];

  for (const [file, record] of [...fileByPath.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (moduleCardPaths.has(file)) continue;
    if (/\.d\.[cm]?ts$/u.test(file)) continue;
    const boundaries = detectBoundaries({
      relativePath: file,
      card: { effect: [], risk: [] },
    }).map((boundary) => boundary.kind);
    const exportedDeclarations = countExportedDeclarations(record.source ?? "", file);
    const entrypoint = entrypoints.has(file);
    const publicApi = publicApiPaths.has(file) && !entrypoint;
    const importers = importedBy.get(file)?.size ?? 0;
    const reexportBarrel = isReexportBarrel(record.source ?? "", file);
    const basename = path.posix.basename(file, path.posix.extname(file)).toLowerCase();
    const broadUtility = UTILITY_NAME_PATTERN.test(basename) ||
      (exportedDeclarations >= 10 && !entrypoint && !publicApi && boundaries.length === 0);
    const nonProduction = NON_PRODUCTION_PATH_PATTERN.test(file);
    const largeSource = record.sourceBytes >= LARGE_SOURCE_BYTES;
    const hasSignal = entrypoint || publicApi || boundaries.length > 0 || importers > 0 || exportedDeclarations > 0 || largeSource;
    if (!hasSignal) continue;

    let score = 0;
    const reasons = ["missing-module-card"];
    if (entrypoint) {
      score += 50;
      reasons.push("package-entrypoint");
    }
    if (publicApi) {
      score += 45;
      reasons.push("public-api-reexport");
    }
    for (const boundary of boundaries) {
      score += boundary === "command" ? 40 : 30;
      reasons.push(`${boundary}-boundary`);
    }
    if (importers > 0) {
      score += Math.min(30, importers * 5);
      reasons.push(`imported-by:${importers}`);
    }
    if (exportedDeclarations > 0) {
      score += 10;
      reasons.push(`exported-declarations:${exportedDeclarations}`);
    }
    if (largeSource) {
      score += 10;
      reasons.push("large-source");
    }
    if (broadUtility) {
      score -= 30;
      reasons.push("broad-utility-penalty");
    }
    if (nonProduction) {
      score -= 40;
      reasons.push("non-production-penalty");
    }
    if (reexportBarrel) {
      score -= 60;
      reasons.push("reexport-barrel-penalty");
    }
    score = Math.max(0, score);
    if (score === 0) continue;
    const priority = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
    candidates.push({
      path: file,
      priority,
      score,
      reasons,
      signals: {
        packageEntrypoint: entrypoint,
        publicApi,
        exportedDeclarations,
        importedBy: importers,
        boundaries,
        largeSource,
        broadUtility,
        nonProduction,
        reexportBarrel,
      },
      suggestedCoverageRule: priority === "low" ? null : buildCoverageSuggestion(file),
    });
  }

  candidates.sort((left, right) =>
    priorityRank(left.priority) - priorityRank(right.priority) ||
    right.score - left.score ||
    compareText(left.path, right.path));
  const summary = {
    analyzedFiles: fileByPath.size,
    cardedFiles: moduleCardPaths.size,
    filesWithoutModuleCards: fileByPath.size - moduleCardPaths.size,
    candidates: candidates.length,
    high: candidates.filter((candidate) => candidate.priority === "high").length,
    medium: candidates.filter((candidate) => candidate.priority === "medium").length,
    low: candidates.filter((candidate) => candidate.priority === "low").length,
    coverageSuggestions: candidates.filter((candidate) => candidate.suggestedCoverageRule !== null).length,
  };
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    repositoryId: project.config.repositoryId,
    summary,
    candidates,
  };
}

export function auditHasFindings(result, minimumPriority = "none") {
  if (minimumPriority === "none") return false;
  if (!AUDIT_PRIORITIES.includes(minimumPriority)) {
    throw new TypeError(`Unknown audit priority: ${minimumPriority}.`);
  }
  const threshold = priorityRank(minimumPriority);
  return result.candidates.some((candidate) => priorityRank(candidate.priority) <= threshold);
}

function buildCoverageSuggestion(file) {
  const stem = path.posix.basename(file, path.posix.extname(file)).replace(/[^a-z0-9]+/giu, "-").toLowerCase();
  return {
    name: `${stem} module boundary`,
    match: [file],
    scope: "module",
    requiredFields: ["owns", "search"],
  };
}

function collectPackageEntrypoints(packageJson, fileByPath) {
  const raw = [packageJson?.main, packageJson?.module, ...collectStringLeaves(packageJson?.bin), ...collectStringLeaves(packageJson?.exports)];
  const entrypoints = new Set();
  for (const value of raw) {
    if (typeof value !== "string" || /\.d\.[cm]?ts$/u.test(value)) continue;
    const normalized = normalizePackagePath(value);
    if (!normalized) continue;
    const resolved = resolveProjectPath(normalized, fileByPath);
    if (resolved) entrypoints.add(resolved);
  }
  return entrypoints;
}

function collectStringLeaves(value, key = "") {
  if (key === "types") return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStringLeaves(item));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, child]) => collectStringLeaves(child, childKey));
}

function normalizePackagePath(value) {
  const normalized = toPosix(value).replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  return path.posix.normalize(normalized);
}

function collectPublicApiPaths(entrypoints, fileByPath) {
  const publicPaths = new Set(entrypoints);
  const queue = [...entrypoints].sort(compareText);
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    const source = fileByPath.get(file)?.source ?? "";
    for (const specifier of extractReexportSpecifiers(source)) {
      const target = resolveLocalSpecifier(file, specifier, fileByPath);
      if (!target || publicPaths.has(target)) continue;
      publicPaths.add(target);
      queue.push(target);
    }
  }
  return publicPaths;
}

function extractReexportSpecifiers(source) {
  const values = [];
  const pattern = /^\s*export\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+["']([^"']+)["']\s*;?/gmu;
  for (const match of source.matchAll(pattern)) values.push(match[1]);
  return [...new Set(values)].sort(compareText);
}

function isReexportBarrel(source, file) {
  if (!/\.[cm]?[jt]sx?$/u.test(file)) return false;
  const reexports = extractReexportSpecifiers(source);
  if (reexports.length === 0) return false;
  const withoutReexports = source
    .replace(/^\s*export\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+["'][^"']+["']\s*;?/gmu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .trim();
  return withoutReexports === "";
}

function resolveLocalSpecifier(fromFile, specifier, fileByPath) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), toPosix(specifier)));
  if (base.startsWith("../") || base === "..") return null;
  return resolveProjectPath(base, fileByPath);
}

function resolveProjectPath(candidate, fileByPath) {
  const values = [candidate];
  const extension = path.posix.extname(candidate);
  if (extension) {
    const stem = candidate.slice(0, -extension.length);
    for (const nextExtension of SOURCE_EXTENSIONS) values.push(`${stem}${nextExtension}`);
  } else {
    for (const nextExtension of SOURCE_EXTENSIONS) {
      values.push(`${candidate}${nextExtension}`);
      values.push(`${candidate}/index${nextExtension}`);
    }
  }
  return values.find((value) => fileByPath.has(value)) ?? null;
}

function countExportedDeclarations(source, file) {
  const extension = path.posix.extname(file).toLowerCase();
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".svelte", ".astro", ".vue"].includes(extension)) {
    const declarations = source.match(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\b/gmu) ?? [];
    const localLists = source.match(/^\s*export\s*\{[^}]*\}\s*;?$/gmu) ?? [];
    const reexports = extractReexportSpecifiers(source).length;
    return declarations.length + localLists.length + reexports;
  }
  if (extension === ".go") {
    return [...source.matchAll(/^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Z][A-Za-z0-9_]*)\b/gmu)].length;
  }
  if (extension === ".rs") return [...source.matchAll(/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\b/gmu)].length;
  if (extension === ".py") return [...source.matchAll(/^\s*(?:async\s+def|def|class)\s+([A-Za-z][A-Za-z0-9_]*)\b/gmu)].filter((match) => !match[1].startsWith("_")).length;
  return 0;
}

function priorityRank(priority) {
  if (priority === "high") return 0;
  if (priority === "medium") return 1;
  if (priority === "low") return 2;
  return 3;
}
