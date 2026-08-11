/* llmnav/1 module
id=llmnav.eval.conformance
role=Measure repository-specific navigation evidence and preserve unmeasured language gaps before stability claims.
owns=conformance matrix validation|repository verdicts|language evidence coverage
excludes=source mutation|cross-repository score averaging
search=cross repository conformance|language coverage matrix|held evaluation
invariant=A passing repository cannot hide a failing repository through aggregate metrics.
invariant=Missing adoption or insufficient reviewed cases remains held rather than passing or failing.
rel=workflow>llmnav.eval.measure
stability=architecture
*/

import { readFile } from "node:fs/promises";
import path from "node:path";
import { auditProject } from "../src/audit.js";
import { evaluateProject } from "../src/evaluation.js";
import { buildArtifactSet } from "../src/generator.js";
import { scanProject } from "../src/project.js";
import { countDiagnostics, validateProject } from "../src/validator.js";
import { readJsonSafe, readText, sha256, stableStringify } from "../src/util.js";

export const CONFORMANCE_MATRIX_SCHEMA_VERSION = 1;
export const CONFORMANCE_REPORT_SCHEMA_VERSION = 1;

export async function loadConformanceMatrix(matrixPath) {
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  validateConformanceMatrix(matrix);
  return matrix;
}

export function validateConformanceMatrix(matrix) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) throw new Error("Conformance matrix must be a JSON object.");
  if (matrix.schemaVersion !== CONFORMANCE_MATRIX_SCHEMA_VERSION) {
    throw new Error(`Conformance matrix schemaVersion must be ${CONFORMANCE_MATRIX_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(matrix.requiredLanguages) || matrix.requiredLanguages.length === 0) {
    throw new Error("Conformance matrix requires at least one required language.");
  }
  if (!Array.isArray(matrix.repositories) || matrix.repositories.length === 0) {
    throw new Error("Conformance matrix requires at least one repository.");
  }
  const seen = new Set();
  for (const repository of matrix.repositories) {
    if (!repository || typeof repository !== "object" || Array.isArray(repository)) throw new Error("Repository entries must be JSON objects.");
    if (typeof repository.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(repository.id)) {
      throw new Error("Repository entries require a stable lowercase id.");
    }
    if (seen.has(repository.id)) throw new Error(`Duplicate conformance repository id ${repository.id}.`);
    seen.add(repository.id);
    if (typeof repository.root !== "string" || path.isAbsolute(repository.root)) {
      throw new Error(`Repository ${repository.id} root must be relative to the LLMNav package root.`);
    }
    if (!Array.isArray(repository.languages) || repository.languages.length === 0) {
      throw new Error(`Repository ${repository.id} requires at least one language.`);
    }
    if (!Number.isInteger(repository.minimumCases) || repository.minimumCases < 1) {
      throw new Error(`Repository ${repository.id} minimumCases must be a positive integer.`);
    }
    if (repository.enabled !== true && repository.enabled !== false) {
      throw new Error(`Repository ${repository.id} enabled must be boolean.`);
    }
  }
}

export async function runConformanceMatrix(matrix, options = {}) {
  validateConformanceMatrix(matrix);
  const packageRoot = path.resolve(options.packageRoot ?? process.cwd());
  const repositories = [];
  for (const entry of matrix.repositories) {
    repositories.push(await measureRepository(packageRoot, entry));
  }
  const languages = matrix.requiredLanguages.map((language) => {
    const passingRepositories = repositories
      .filter((repository) => repository.verdict === "pass" && repository.languages.includes(language))
      .map((repository) => repository.id);
    return {
      language,
      verdict: passingRepositories.length > 0 ? "pass" : "held",
      passingRepositories,
    };
  });
  const failedRepositories = repositories.filter((repository) => repository.verdict === "fail").map((repository) => repository.id);
  const heldLanguages = languages.filter((language) => language.verdict === "held").map((language) => language.language);
  const verdict = failedRepositories.length > 0 ? "fail" : heldLanguages.length > 0 ? "held" : "pass";
  return {
    schemaVersion: CONFORMANCE_REPORT_SCHEMA_VERSION,
    matrixHash: sha256(stableStringify(matrix)),
    measuredAt: options.measuredAt ?? new Date().toISOString(),
    verdict,
    summary: {
      repositories: repositories.length,
      passed: repositories.filter((repository) => repository.verdict === "pass").length,
      failed: failedRepositories.length,
      held: repositories.filter((repository) => repository.verdict === "held").length,
      requiredLanguages: languages.length,
      coveredLanguages: languages.filter((language) => language.verdict === "pass").length,
      failedRepositories,
      heldLanguages,
    },
    languages,
    repositories,
  };
}

async function measureRepository(packageRoot, entry) {
  const portable = {
    id: entry.id,
    root: entry.root,
    languages: [...entry.languages].sort(),
    enabled: entry.enabled,
    minimumCases: entry.minimumCases,
  };
  if (!entry.enabled) {
    return { ...portable, verdict: "held", reasons: [entry.holdReason ?? "repository-not-enabled"], evidence: null };
  }
  const root = path.resolve(packageRoot, entry.root);
  if (!(await fileExists(path.join(root, ".llmnav", "config.json")))) {
    return { ...portable, verdict: "held", reasons: ["missing-llmnav-configuration"], evidence: null };
  }
  if (!(await fileExists(path.join(root, ".llmnav", "eval", "queries.jsonl")))) {
    return { ...portable, verdict: "held", reasons: ["missing-evaluation-dataset"], evidence: null };
  }

  try {
    const project = await scanProject(root);
    if (project.config.repositoryId !== entry.id) {
      return { ...portable, verdict: "fail", reasons: [`repository-id-mismatch:${project.config.repositoryId}`], evidence: null };
    }
    const diagnostics = validateProject(project);
    const diagnosticCounts = countDiagnostics(diagnostics);
    const firstEvaluation = await evaluateProject(root);
    const secondEvaluation = await evaluateProject(root);
    const evaluationRepeatable = stableStringify(firstEvaluation) === stableStringify(secondEvaluation);
    const audit = await auditProject(root);
    const order = (await readText(path.join(root, ".llmnav", "order.lock"), ""))
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value && !value.startsWith("#"));
    const rebuilt = buildArtifactSet(project, order);
    const generatedIndex = await readJsonSafe(path.join(root, project.config.generation.cacheDirectory, "index.json"), null);
    const cacheFresh = generatedIndex?.sourceHash === rebuilt.index.sourceHash;
    const reasons = [];
    if (diagnosticCounts.error > 0) reasons.push("validation-errors");
    if (!firstEvaluation.ok) reasons.push("retrieval-threshold-failed");
    if (!evaluationRepeatable) reasons.push("evaluation-not-repeatable");
    if (!cacheFresh) reasons.push("generated-cache-stale");
    if (firstEvaluation.metrics.total < entry.minimumCases) reasons.push("insufficient-evaluation-cases");
    const verdict = reasons.includes("insufficient-evaluation-cases") && reasons.length === 1
      ? "held"
      : reasons.length > 0 ? "fail" : "pass";
    return {
      ...portable,
      verdict,
      reasons,
      evidence: {
        sourceFiles: project.fileRecords.length,
        cards: project.records.length,
        diagnostics: diagnosticCounts,
        evaluation: {
          ...firstEvaluation.metrics,
          thresholds: firstEvaluation.thresholds ?? null,
          repeatable: evaluationRepeatable,
        },
        audit: audit.summary,
        cache: {
          fresh: cacheFresh,
          generatedSourceHash: generatedIndex?.sourceHash ?? null,
          rebuiltSourceHash: rebuilt.index.sourceHash,
        },
      },
    };
  } catch (error) {
    return {
      ...portable,
      verdict: "fail",
      reasons: [`measurement-error:${error instanceof Error ? error.message : String(error)}`],
      evidence: null,
    };
  }
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}
