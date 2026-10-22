/* llmnav/1 module
id=llmnav.audit.coverage
role=Identify high-value source modules that lack semantic navigation boundaries without modifying source.
owns=annotation coverage audit|candidate prioritization|file explanation|coverage rule suggestions
excludes=automatic source annotation|semantic role generation
search=llmnav audit|missing module cards|explain missing annotation|coverage suggestions
invariant=Audit output is deterministic, repository-relative, and advisory unless an explicit fail threshold is selected.
rel=workflow>llmnav.project.scan
stability=contract
*/

import path from "node:path";
import { throwIfAborted } from "./abort.js";
import { detectBoundaries } from "./boundaries.js";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { moduleKeyForFile, resolveGoImportModule } from "./module-resolution.js";
import { scanProject } from "./project.js";
import { AUDIT_LIMITS, AUDIT_REPRESENTATIVE, AUDIT_SCORING } from "./policy.js";
import { compareText, readJsonSafe, toPosix } from "./util.js";

export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_PRIORITIES = Object.freeze(["high", "medium", "low"]);
export const FILE_EXPLANATION_SCHEMA_VERSION = 1;

const SOURCE_EXTENSIONS = Object.freeze([
  ".astro", ".c", ".cc", ".cjs", ".cpp", ".cs", ".cts", ".dart", ".go", ".h", ".hpp", ".java",
  ".js", ".jsx", ".kt", ".kts", ".mjs", ".mts", ".php", ".py", ".rb", ".rs", ".svelte", ".swift",
  ".ts", ".tsx", ".vue",
]);
const UTILITY_NAME_PATTERN = /^(?:common|helpers?|shared|utils?)$/u;
const NON_PRODUCTION_PATH_PATTERN = /(?:^|\/)(?:__tests__|benchmarks?|fixtures?|testdata|tests?)(?:\/|$)|\.(?:spec|test)\.[^/]+$|_test\.go$/u;
const LARGE_SOURCE_BYTES = 12_000;

export async function auditProject(root, options = {}) {
  return (await analyzeAuditProject(root, options)).result;
}

export async function explainProjectFile(root, inputPath, options = {}) {
  const file = normalizeExplanationPath(root, inputPath);
  const analysis = await analyzeAuditProject(root, options);
  const { project, fileByPath, candidates, result } = analysis;
  const moduleKey = fileByPath.has(file) ? moduleKeyForFile(file) : null;
  const navigationCards = [];
  const coverageCards = [];
  for (const record of project.records) {
    const cardPath = toPosix(record.relativePath);
    if (cardPath === file) navigationCards.push({ id: record.card.id, scope: record.card.scope, path: file });
    if (moduleKey === null) continue;
    const coversModule = record.card.scope === "file" ?
      cardPath === file :
      record.card.scope === "module" && moduleKeyForFile(cardPath) === moduleKey;
    if (coversModule) coverageCards.push({ id: record.card.id, scope: record.card.scope, path: cardPath });
  }
  navigationCards.sort((left, right) => compareText(left.id, right.id));
  coverageCards.sort((left, right) => compareText(left.id, right.id));
  const candidate = moduleKey === null ? null : candidates.find((item) => moduleKeyForFile(item.path) === moduleKey) ?? null;
  const dispositionPath = candidate?.path ?? file;
  const dispositionsByPath = new Map(result.dispositions.map((item) => [item.path, item]));
  const disposition = dispositionsByPath.get(dispositionPath) ?? dispositionsByPath.get(file) ?? null;

  if (disposition?.status === "stale") {
    return buildFileExplanation(result.repositoryId, file, moduleKey, "stale-disposition", navigationCards, coverageCards, candidate, disposition, [
      `stale-disposition:${disposition.staleReason}`,
    ], "remove-or-review-disposition", "Remove or update the stale exact-path disposition after reviewing the current file state.");
  }
  if (!fileByPath.has(file)) {
    return buildFileExplanation(result.repositoryId, file, null, "not-scanned", [], [], null, disposition, ["file-not-scanned"],
      "check-scan-configuration", "Check that the file exists under a source root and is not excluded by extension, directory, or file rules.");
  }
  if (coverageCards.length > 0) {
    const status = coverageCards.some((card) => card.path === file) ? "carded" : "covered";
    return buildFileExplanation(result.repositoryId, file, moduleKey, status, navigationCards, coverageCards, null, disposition,
      [status === "carded" ? "file-has-coverage-card" : "module-covered-by-card"],
      "keep-current-coverage", "No additional file or module card is needed unless this file gains a separate durable responsibility.");
  }
  if (candidate && disposition?.status === "suppressed") {
    return buildFileExplanation(result.repositoryId, file, moduleKey, "suppressed", navigationCards, coverageCards, candidate, disposition,
      ["reviewed-exact-path-disposition", ...candidate.reasons], "keep-or-review-disposition",
      "Keep the disposition while its reason remains true; remove it if the file gains a durable navigation responsibility.");
  }
  if (candidate) {
    const action = candidate.priority === "low" ? "review-or-disposition" : "review-card";
    const message = candidate.priority === "low"
      ? "Review the low-priority signal, but do not add a card unless the file owns a durable navigation responsibility."
      : "Review the candidate and either add one durable card with exact coverage or record an exact-path disposition with a concrete reason.";
    return buildFileExplanation(result.repositoryId, file, moduleKey, "candidate", navigationCards, coverageCards, candidate, null,
      candidate.reasons, action, message);
  }
  const reasons = /\.d\.[cm]?ts$/u.test(file) ? ["declaration-file"] : ["no-ranked-audit-signal"];
  return buildFileExplanation(result.repositoryId, file, moduleKey, "not-candidate", navigationCards, coverageCards, null, disposition, reasons,
    "no-card-needed", "Do not add a card solely for coverage; revisit only if the file gains a durable responsibility or stronger structural signals.");
}

async function analyzeAuditProject(root, options = {}) {
  throwIfAborted(options.signal);
  const project = await scanProject(root, options);
  const coverage = buildCoverageIndexes(project);
  const filesByModule = groupFilesByModule(coverage.fileByPath);
  const moduleKeys = new Set(filesByModule.keys());
  const importedBy = buildImportedBy(filesByModule, coverage.fileByPath, project.moduleResolution, moduleKeys);
  const { entrypoints, publicApiPaths } = await collectNavigationSignals(root, coverage.fileByPath, options);
  const candidates = rankCandidates({ filesByModule, coverage, importedBy, entrypoints, publicApiPaths, signal: options.signal });
  candidates.sort(compareAuditCandidates);
  const { activeCandidates, dispositions } = applyDispositions(project, candidates, coverage);
  const summary = summarizeAudit(coverage, activeCandidates, dispositions);
  const result = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    repositoryId: project.config.repositoryId,
    summary,
    candidates: activeCandidates,
    dispositions,
  };
  return { project, fileByPath: coverage.fileByPath, candidates, result };
}

function buildCoverageIndexes(project) {
  const fileByPath = new Map(
    project.fileRecords.map((record) => [toPosix(record.relativePath), record]),
  );
  const cardedFilePaths = new Set(
    project.records
      .filter((record) => record.card.scope === "file" || record.card.scope === "module")
      .map((record) => toPosix(record.relativePath)),
  );
  const exactCardPaths = new Set(
    project.records
      .filter((record) => record.card.scope === "file")
      .map((record) => toPosix(record.relativePath)),
  );
  const coveredModules = new Set(
    project.records
      .filter((record) => record.card.scope === "module")
      .map((record) => moduleKeyForFile(record.relativePath)),
  );
  return { fileByPath, cardedFilePaths, exactCardPaths, coveredModules };
}

function buildImportedBy(filesByModule, fileByPath, moduleResolution, moduleKeys) {
  const importedBy = new Map([...moduleKeys].map((key) => [key, new Set()]));
  for (const [sourceKey, files] of filesByModule) {
    const targets = new Set();
    for (const [file, record] of files) {
      for (const specifier of record.imports) {
        const target = resolveImportedModule(file, specifier, fileByPath, moduleResolution, moduleKeys);
        if (target) targets.add(target);
      }
    }
    for (const target of targets) importedBy.get(target)?.add(sourceKey);
  }
  return importedBy;
}

async function collectNavigationSignals(root, fileByPath, options) {
  const entrypoints = await collectWorkspacePackageEntrypoints(root, fileByPath, options);
  collectGoEntrypoints(fileByPath, entrypoints);
  return { entrypoints, publicApiPaths: collectPublicApiPaths(entrypoints, fileByPath) };
}

function rankCandidates({ filesByModule, coverage, importedBy, entrypoints, publicApiPaths, signal }) {
  const candidates = [];
  const modules = [...filesByModule.entries()].sort(([left], [right]) => compareText(left, right));
  for (const [moduleKey, files] of modules) {
    throwIfAborted(signal);
    const candidate = rankModuleCandidate(moduleKey, files, coverage, importedBy, entrypoints, publicApiPaths);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}

function rankModuleCandidate(moduleKey, files, coverage, importedBy, entrypoints, publicApiPaths) {
  if (coverage.coveredModules.has(moduleKey)) return null;
  const selectableFiles = files.filter(([file]) => !coverage.exactCardPaths.has(file) && !/\.d\.[cm]?ts$/u.test(file));
  if (selectableFiles.length === 0) return null;
  const productionFiles = selectableFiles.filter(([file]) => !NON_PRODUCTION_PATH_PATTERN.test(file));
  const analyzedFiles = productionFiles.length > 0 ? productionFiles : selectableFiles;
  const audit = auditModuleSources(analyzedFiles);
  const file = selectRepresentativeFile(analyzedFiles, entrypoints, audit.exportedDeclarations);
  const record = coverage.fileByPath.get(file);
  const boundaries = [...new Set(analyzedFiles.flatMap(([candidate]) => audit.boundaries.get(candidate)))].sort(compareText);
  const exportedDeclarations = analyzedFiles.reduce(
    (sum, [candidate]) => sum + audit.exportedDeclarations.get(candidate),
    0,
  );
  const entrypoint = analyzedFiles.some(([candidate]) => entrypoints.has(candidate));
  const publicApi = analyzedFiles.some(([candidate]) => publicApiPaths.has(candidate) && !entrypoints.has(candidate));
  const importers = importedBy.get(moduleKey)?.size ?? 0;
  const reexportBarrel = analyzedFiles.length === 1 && isReexportBarrel(record.source ?? "", file);
  const isGoModule = moduleKey.startsWith("go:");
  const moduleName = isGoModule ? moduleKey.slice(3) : file;
  const basename = path.posix.basename(moduleName, path.posix.extname(moduleName)).toLowerCase();
  const broadUtility = UTILITY_NAME_PATTERN.test(basename) ||
    (!isGoModule && exportedDeclarations >= 10 && importers <= 1 && !entrypoint && !publicApi && boundaries.length === 0);
  const nonProduction = productionFiles.length === 0;
  const largeSource = analyzedFiles.reduce((sum, [, item]) => sum + item.sourceBytes, 0) >= LARGE_SOURCE_BYTES;
  const hasSignal = entrypoint || publicApi || boundaries.length > 0 || importers > 0 || exportedDeclarations > 0 || largeSource;
  if (!hasSignal) return null;
  const { score, reasons } = scoreAuditSignals({
    entrypoint,
    publicApi,
    boundaries,
    importers,
    exportedDeclarations,
    largeSource,
    broadUtility,
    nonProduction,
    reexportBarrel,
  });
  if (score === 0) return null;
  const priority = priorityForScore(score);
  return {
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
  };
}

function scoreAuditSignals(signals) {
  let score = 0;
  const reasons = ["missing-module-card"];
  if (signals.entrypoint) {
    score += AUDIT_SCORING.entrypoint;
    reasons.push("package-entrypoint");
  }
  if (signals.publicApi) {
    score += AUDIT_SCORING.publicApi;
    reasons.push("public-api-reexport");
  }
  for (const boundary of signals.boundaries) {
    score += boundary === "command" ? AUDIT_SCORING.commandBoundary : AUDIT_SCORING.otherBoundary;
    reasons.push(`${boundary}-boundary`);
  }
  if (signals.importers > 0) {
    score += Math.min(AUDIT_SCORING.importerMaximum, signals.importers * AUDIT_SCORING.importer);
    reasons.push(`imported-by:${signals.importers}`);
  }
  if (signals.exportedDeclarations > 0) {
    score += AUDIT_SCORING.exportedDeclarations;
    reasons.push(`exported-declarations:${signals.exportedDeclarations}`);
  }
  if (signals.largeSource) {
    score += AUDIT_SCORING.largeSource;
    reasons.push("large-source");
  }
  if (signals.broadUtility) {
    score -= AUDIT_SCORING.broadUtilityPenalty;
    reasons.push("broad-utility-penalty");
  }
  if (signals.nonProduction) {
    score -= AUDIT_SCORING.nonProductionPenalty;
    reasons.push("non-production-penalty");
  }
  if (signals.reexportBarrel) {
    score -= AUDIT_SCORING.reexportBarrelPenalty;
    reasons.push("reexport-barrel-penalty");
  }
  return { score: Math.max(0, score), reasons };
}

function priorityForScore(score) {
  if (score >= AUDIT_SCORING.highPriorityMinimum) return "high";
  if (score >= AUDIT_SCORING.mediumPriorityMinimum) return "medium";
  return "low";
}

function applyDispositions(project, candidates, coverage) {
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  const dispositions = [...project.config.audit.dispositions]
    .sort((left, right) => compareText(left.path, right.path))
    .map((disposition) => {
      const candidate = candidateByPath.get(disposition.path);
      if (candidate) {
        candidateByPath.delete(disposition.path);
        return {
          path: disposition.path,
          reason: disposition.reason,
          status: "suppressed",
          priority: candidate.priority,
          score: candidate.score,
        };
      }
      return {
        path: disposition.path,
        reason: disposition.reason,
        status: "stale",
        staleReason: classifyStaleDisposition(disposition.path, coverage.fileByPath, coverage.exactCardPaths, coverage.coveredModules),
      };
    });
  const activeCandidates = candidates.filter((candidate) => candidateByPath.has(candidate.path));
  return { activeCandidates, dispositions };
}

function summarizeAudit(coverage, activeCandidates, dispositions) {
  return {
    analyzedFiles: coverage.fileByPath.size,
    cardedFiles: coverage.cardedFilePaths.size,
    filesWithoutModuleCards: coverage.fileByPath.size - coverage.cardedFilePaths.size,
    candidates: activeCandidates.length,
    high: activeCandidates.filter((candidate) => candidate.priority === "high").length,
    medium: activeCandidates.filter((candidate) => candidate.priority === "medium").length,
    low: activeCandidates.filter((candidate) => candidate.priority === "low").length,
    coverageSuggestions: activeCandidates.filter((candidate) => candidate.suggestedCoverageRule !== null).length,
    suppressedCandidates: dispositions.filter((disposition) => disposition.status === "suppressed").length,
    staleDispositions: dispositions.filter((disposition) => disposition.status === "stale").length,
  };
}

function compareAuditCandidates(left, right) {
  return priorityRank(left.priority) - priorityRank(right.priority) ||
    right.score - left.score ||
    compareText(left.path, right.path);
}

function normalizeExplanationPath(root, inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") throw new TypeError("explain requires one file path.");
  const rootPath = path.resolve(root);
  const absolutePath = path.resolve(rootPath, inputPath);
  const relativePath = path.relative(rootPath, absolutePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new RangeError("explain path must name one file inside the repository root.");
  }
  return toPosix(relativePath);
}

function buildFileExplanation(repositoryId, file, moduleKey, status, navigationCards, coverageCards, candidate, disposition, reasons, action, message) {
  return {
    schemaVersion: FILE_EXPLANATION_SCHEMA_VERSION,
    repositoryId,
    path: file,
    moduleKey,
    status,
    navigationCards,
    coverageCards,
    candidate,
    disposition,
    reasons,
    recommendation: { action, message },
  };
}

function classifyStaleDisposition(file, fileByPath, exactCardPaths, coveredModules) {
  if (!fileByPath.has(file)) return "file-not-scanned";
  if (exactCardPaths.has(file) || coveredModules.has(moduleKeyForFile(file))) return "already-carded";
  return "not-a-candidate";
}

function groupFilesByModule(fileByPath) {
  const output = new Map();
  for (const [file, record] of fileByPath) {
    const key = moduleKeyForFile(file);
    const files = output.get(key) ?? [];
    files.push([file, record]);
    output.set(key, files);
  }
  for (const files of output.values()) files.sort(([left], [right]) => compareText(left, right));
  return output;
}

function resolveImportedModule(file, specifier, fileByPath, moduleResolution, moduleKeys) {
  const goTarget = resolveGoImportModule(file, specifier, moduleResolution, moduleKeys);
  if (goTarget) return goTarget;
  const target = resolveLocalSpecifier(file, specifier, fileByPath);
  return target ? moduleKeyForFile(target) : null;
}

function collectGoEntrypoints(fileByPath, entrypoints) {
  for (const [file, record] of fileByPath) {
    if (!file.endsWith(".go") || path.posix.basename(file) !== "main.go") continue;
    if (/^\s*package\s+main\b/mu.test(record.source ?? "")) entrypoints.add(file);
  }
}

function auditModuleSources(files) {
  const exportedDeclarations = new Map();
  const boundaries = new Map();
  for (const [file, item] of files) {
    const source = item.source ?? "";
    exportedDeclarations.set(file, countExportedDeclarations(source, file));
    boundaries.set(file, detectBoundaries({ relativePath: file, card: { effect: [], risk: [] }, source })
      .map((boundary) => boundary.kind));
  }
  return { exportedDeclarations, boundaries };
}

function selectRepresentativeFile(files, entrypoints, exportedDeclarations) {
  const ranked = files.map(([file, record]) => ({
    file,
    score: representativeScore(file, record, entrypoints, exportedDeclarations.get(file) ?? 0),
  }));
  ranked.sort((left, right) => right.score - left.score || compareText(left.file, right.file));
  return ranked[0].file;
}

function representativeScore(file, record, entrypoints, exportedDeclarations) {
  let score = entrypoints.has(file) ? AUDIT_REPRESENTATIVE.entrypoint : 0;
  if (path.posix.basename(file) === "doc.go") score += AUDIT_REPRESENTATIVE.goPackageDocumentation;
  score += exportedDeclarations * AUDIT_REPRESENTATIVE.exportedDeclaration;
  score += Math.min(AUDIT_REPRESENTATIVE.sourceSizeMaximum, Math.floor(record.sourceBytes / AUDIT_REPRESENTATIVE.sourceBytesPerPoint));
  return score;
}

export function auditHasFindings(result, minimumPriority = "none") {
  if (minimumPriority === "none") return false;
  if (!AUDIT_PRIORITIES.includes(minimumPriority)) {
    throw new TypeError(`Unknown audit priority: ${minimumPriority}.`);
  }
  const threshold = priorityRank(minimumPriority);
  return result.candidates.some((candidate) => priorityRank(candidate.priority) <= threshold);
}

export function selectAuditCandidates(result, minimumPriority = "low", top = AUDIT_LIMITS.top.default) {
  if (!AUDIT_PRIORITIES.includes(minimumPriority)) {
    throw new TypeError(`Unknown audit priority: ${minimumPriority}.`);
  }
  if (!Number.isInteger(top) || top < 1) {
    throw new TypeError(`Audit candidate limit must be a positive integer: ${top}.`);
  }
  const threshold = priorityRank(minimumPriority);
  const selected = result.candidates.filter((candidate) => priorityRank(candidate.priority) <= threshold);
  return { candidates: selected.slice(0, top), matched: selected.length, truncated: selected.length > top };
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

async function collectWorkspacePackageEntrypoints(root, fileByPath, options) {
  const packageDirectories = new Set([""]);
  for (const file of fileByPath.keys()) {
    let directory = path.posix.dirname(file);
    while (directory !== "." && directory !== "") {
      packageDirectories.add(directory);
      const parent = path.posix.dirname(directory);
      if (parent === directory || parent === ".") break;
      directory = parent;
    }
  }
  const directories = [...packageDirectories].sort(compareText);
  const packageJsons = await mapWithConcurrency(
    directories,
    options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY,
    (directory) => readJsonSafe(path.join(root, directory, "package.json"), null),
  );
  const entrypoints = new Set();
  for (const [index, directory] of directories.entries()) {
    const packageJson = packageJsons[index];
    if (!packageJson || typeof packageJson !== "object") continue;
    for (const entrypoint of collectPackageEntrypoints(packageJson, fileByPath, directory)) entrypoints.add(entrypoint);
  }
  return entrypoints;
}

function collectPackageEntrypoints(packageJson, fileByPath, packageDirectory = "") {
  const raw = [packageJson?.main, packageJson?.module, ...collectStringLeaves(packageJson?.bin), ...collectStringLeaves(packageJson?.exports)];
  const entrypoints = new Set();
  for (const value of raw) {
    if (typeof value !== "string" || /\.d\.[cm]?ts$/u.test(value)) continue;
    const normalized = normalizePackagePath(value);
    if (!normalized) continue;
    const resolved = resolveProjectPath(path.posix.join(packageDirectory, normalized), fileByPath);
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
  if (/\.rs$/u.test(fromFile)) return resolveRustSpecifier(fromFile, specifier, fileByPath);
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), toPosix(specifier)));
  if (base.startsWith("../") || base === "..") return null;
  return resolveProjectPath(base, fileByPath);
}

function resolveRustSpecifier(fromFile, specifier, fileByPath) {
  const normalized = specifier
    .replace(/\s+as\s+.+$/u, "")
    .replace(/::\{[\s\S]*$/u, "")
    .replace(/::\*$/u, "")
    .trim();
  if (!normalized || /[{}(),]/u.test(normalized)) return null;
  const parts = normalized.split("::").filter(Boolean);
  const sourceIndex = fromFile.split("/").lastIndexOf("src");
  const crateSource = sourceIndex >= 0 ? fromFile.split("/").slice(0, sourceIndex + 1).join("/") : path.posix.dirname(fromFile);
  let base;
  if (parts[0] === "crate") {
    parts.shift();
    base = crateSource;
  } else if (parts[0] === "self") {
    parts.shift();
    base = rustModuleDirectory(fromFile);
  } else if (parts[0] === "super") {
    while (parts[0] === "super") {
      parts.shift();
      base = path.posix.dirname(base ?? rustModuleDirectory(fromFile));
    }
  } else {
    base = rustModuleDirectory(fromFile);
  }
  if (parts.length === 0) return null;
  const candidate = path.posix.join(base, ...parts);
  return [
    `${candidate}.rs`,
    `${candidate}/mod.rs`,
  ].find((value) => fileByPath.has(value)) ?? null;
}

function rustModuleDirectory(fromFile) {
  const basename = path.posix.basename(fromFile);
  if (basename === "lib.rs" || basename === "main.rs" || basename === "mod.rs") return path.posix.dirname(fromFile);
  return path.posix.join(path.posix.dirname(fromFile), path.posix.basename(fromFile, ".rs"));
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
