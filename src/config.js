import path from "node:path";
import {
  ALLOWED_KEYS,
  DEFAULT_CONFIG,
  EFFECT_KINDS,
  FORBIDDEN_STRUCTURE_RELATIONS,
  RELATION_KINDS,
  RISK_KINDS,
  SCOPES,
  STABILITIES,
} from "./spec.js";
import { deepMerge, readJson } from "./util.js";

const REPOSITORY_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const CONTROLLED_KIND_PATTERN = /^[a-z][a-z0-9.-]*$/u;
const RELATION_KIND_PATTERN = /^[a-z][a-z0-9-]*$/u;
const TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
const LINT_KEYS = new Set(Object.keys(DEFAULT_CONFIG.lint));
const GENERATION_KEYS = new Set(Object.keys(DEFAULT_CONFIG.generation));
const EVALUATION_KEYS = new Set(Object.keys(DEFAULT_CONFIG.evaluation));
const COVERAGE_KEYS = new Set(["name", "match", "scope", "requiredFields"]);

export async function loadConfig(root) {
  const configPath = path.join(root, ".llmnav", "config.json");
  const custom = await readJson(configPath, {});
  const config = deepMerge(DEFAULT_CONFIG, custom);
  validateConfig(config, configPath);
  return { config, configPath };
}

export function validateConfig(config, configPath = ".llmnav/config.json") {
  const problems = [];
  if (!isObject(config)) throw new Error(`${configPath}:\n  configuration must be a JSON object`);
  validateObjectKeys(config, TOP_LEVEL_KEYS, "configuration", problems);

  if (config.$schema !== undefined && (typeof config.$schema !== "string" || !config.$schema.trim())) {
    problems.push("$schema must be a non-empty string when present");
  }
  if (config.version !== 1) problems.push("version must be 1");
  if (typeof config.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(config.repositoryId)) {
    problems.push("repositoryId must match ^[a-z][a-z0-9-]{0,63}$");
  }

  validateStringArray(config.sourceRoots, "sourceRoots", problems, { minimum: 1, unique: true });
  if (Array.isArray(config.sourceRoots)) {
    for (const [index, sourceRoot] of config.sourceRoots.entries()) {
      const problem = validateProjectRelativePath(sourceRoot, { allowDot: true });
      if (problem) problems.push(`sourceRoots[${index}] ${problem}`);
    }
  }

  validateStringArray(config.includeExtensions, "includeExtensions", problems, { minimum: 1, unique: true });
  if (Array.isArray(config.includeExtensions)) {
    for (const [index, extension] of config.includeExtensions.entries()) {
      if (!extension.startsWith(".") || /[\\/\s]/u.test(extension)) {
        problems.push(`includeExtensions[${index}] must be a dot-prefixed extension without path separators`);
      }
    }
  }
  validateStringArray(config.excludeDirectories, "excludeDirectories", problems, { unique: true });
  validateStringArray(config.excludeFiles, "excludeFiles", problems, { unique: true });
  validateCoverageRules(config.coverageRules, problems);

  validateLint(config.lint, problems);
  validateGeneration(config.generation, problems);
  validateEvaluation(config.evaluation, problems);

  if (problems.length > 0) {
    throw new Error(`${configPath}:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  }
}

function validateCoverageRules(rules, problems) {
  if (!Array.isArray(rules)) {
    problems.push("coverageRules must be an array");
    return;
  }
  for (const [index, rule] of rules.entries()) {
    const name = `coverageRules[${index}]`;
    if (!isObject(rule)) {
      problems.push(`${name} must be an object`);
      continue;
    }
    validateObjectKeys(rule, COVERAGE_KEYS, name, problems);
    if (rule.name !== undefined && (typeof rule.name !== "string" || !rule.name.trim())) {
      problems.push(`${name}.name must be a non-empty string when present`);
    }
    validateStringArray(rule.match, `${name}.match`, problems, { minimum: 1, unique: true });
    if (rule.scope !== undefined && !SCOPES.includes(rule.scope)) {
      problems.push(`${name}.scope must be one of ${SCOPES.join(", ")}`);
    }
    if (rule.requiredFields !== undefined) {
      validateStringArray(rule.requiredFields, `${name}.requiredFields`, problems, { unique: true });
      if (Array.isArray(rule.requiredFields)) {
        for (const field of rule.requiredFields) {
          if (!ALLOWED_KEYS.includes(field)) problems.push(`${name}.requiredFields contains unknown field ${JSON.stringify(field)}`);
        }
      }
    }
  }
}

function validateLint(lint, problems) {
  if (!isObject(lint)) {
    problems.push("lint must be an object");
    return;
  }
  validateObjectKeys(lint, LINT_KEYS, "lint", problems);

  validateInteger(lint.maxRoleLength, "lint.maxRoleLength", problems, 40);
  validateInteger(lint.maxSearchTerms, "lint.maxSearchTerms", problems, 1);
  validateInteger(lint.minSearchTerms, "lint.minSearchTerms", problems, 0);
  validateInteger(lint.maxInvariants, "lint.maxInvariants", problems, 0);
  validateInteger(lint.maxEffects, "lint.maxEffects", problems, 0);
  validateInteger(lint.maxRelations, "lint.maxRelations", problems, 0);
  validateInteger(lint.minimumSourceBytesForRatio, "lint.minimumSourceBytesForRatio", problems, 0);
  validateInteger(lint.minimumCardsForSaturation, "lint.minimumCardsForSaturation", problems, 1);
  if (Number.isInteger(lint.minSearchTerms) && Number.isInteger(lint.maxSearchTerms) && lint.minSearchTerms > lint.maxSearchTerms) {
    problems.push("lint.minSearchTerms must not exceed lint.maxSearchTerms");
  }

  for (const key of ["maxSemanticRatio", "searchTermSaturation"]) {
    if (typeof lint[key] !== "number" || !Number.isFinite(lint[key]) || lint[key] < 0 || lint[key] > 1) {
      problems.push(`lint.${key} must be a number from 0 to 1`);
    }
  }

  if (!isObject(lint.maxBlockBytes)) {
    problems.push("lint.maxBlockBytes must be an object");
  } else {
    validateObjectKeys(lint.maxBlockBytes, new Set(SCOPES), "lint.maxBlockBytes", problems);
    for (const scope of SCOPES) validateInteger(lint.maxBlockBytes[scope], `lint.maxBlockBytes.${scope}`, problems, 100);
  }

  for (const key of [
    "genericSearchTerms",
    "vagueRoleWords",
    "strictRisks",
    "additionalEffects",
    "additionalRisks",
    "additionalRelations",
  ]) {
    validateStringArray(lint[key], `lint.${key}`, problems, { unique: true });
  }

  validateVocabularyExtensions(lint, problems);
  for (const key of ["requireCanonicalOrder", "requireCanonicalFormatting"]) {
    if (typeof lint[key] !== "boolean") problems.push(`lint.${key} must be a boolean`);
  }
}

function validateVocabularyExtensions(lint, problems) {
  const baseEffects = new Set(EFFECT_KINDS);
  const baseRisks = new Set(RISK_KINDS);
  const baseRelations = new Set(RELATION_KINDS);
  const forbiddenRelations = new Set(FORBIDDEN_STRUCTURE_RELATIONS);

  for (const [index, effect] of (Array.isArray(lint.additionalEffects) ? lint.additionalEffects : []).entries()) {
    if (!CONTROLLED_KIND_PATTERN.test(effect)) {
      problems.push(`lint.additionalEffects[${index}] must be a controlled effect kind such as queue.publish`);
    } else if (baseEffects.has(effect)) {
      problems.push(`lint.additionalEffects[${index}] duplicates base effect ${effect}`);
    }
  }
  for (const [index, risk] of (Array.isArray(lint.additionalRisks) ? lint.additionalRisks : []).entries()) {
    if (!CONTROLLED_KIND_PATTERN.test(risk)) {
      problems.push(`lint.additionalRisks[${index}] must be a controlled lower-case identifier`);
    } else if (baseRisks.has(risk)) {
      problems.push(`lint.additionalRisks[${index}] duplicates base risk ${risk}`);
    }
  }
  for (const [index, relation] of (Array.isArray(lint.additionalRelations) ? lint.additionalRelations : []).entries()) {
    if (!RELATION_KIND_PATTERN.test(relation)) {
      problems.push(`lint.additionalRelations[${index}] must be a controlled lower-case relation type`);
    } else if (baseRelations.has(relation) || forbiddenRelations.has(relation)) {
      problems.push(`lint.additionalRelations[${index}] uses reserved relation ${relation}`);
    }
  }

  const allowedRisks = new Set([
    ...RISK_KINDS,
    ...(Array.isArray(lint.additionalRisks) ? lint.additionalRisks : []),
  ]);
  for (const [index, risk] of (Array.isArray(lint.strictRisks) ? lint.strictRisks : []).entries()) {
    if (!allowedRisks.has(risk)) problems.push(`lint.strictRisks[${index}] contains unknown risk ${JSON.stringify(risk)}`);
  }
}

function validateGeneration(generation, problems) {
  if (!isObject(generation)) {
    problems.push("generation must be an object");
    return;
  }
  validateObjectKeys(generation, GENERATION_KEYS, "generation", problems);
  const cacheProblem = validateProjectRelativePath(generation.cacheDirectory, {
    requiredPrefix: ".llmnav/",
  });
  if (cacheProblem) problems.push(`generation.cacheDirectory ${cacheProblem}`);
  if (!Number.isInteger(generation.moduleDepth) || generation.moduleDepth < 1 || generation.moduleDepth > 6) {
    problems.push("generation.moduleDepth must be an integer from 1 to 6");
  }
  for (const key of ["repositoryCatalogStabilities", "moduleCatalogStabilities"]) {
    validateStringArray(generation[key], `generation.${key}`, problems, { unique: true });
    if (Array.isArray(generation[key])) {
      for (const value of generation[key]) {
        if (!STABILITIES.includes(value)) problems.push(`generation.${key} contains unknown stability ${JSON.stringify(value)}`);
      }
    }
  }
}

function validateEvaluation(evaluation, problems) {
  if (!isObject(evaluation)) {
    problems.push("evaluation must be an object");
    return;
  }
  validateObjectKeys(evaluation, EVALUATION_KEYS, "evaluation", problems);
  const queryProblem = validateProjectRelativePath(evaluation.queryFile);
  if (queryProblem) problems.push(`evaluation.queryFile ${queryProblem}`);
  for (const key of ["minimumRecallAt1", "minimumRecallAt5"]) {
    if (typeof evaluation[key] !== "number" || !Number.isFinite(evaluation[key]) || evaluation[key] < 0 || evaluation[key] > 1) {
      problems.push(`evaluation.${key} must be a number from 0 to 1`);
    }
  }
}

function validateObjectKeys(value, allowed, name, problems) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problems.push(`${name} contains unknown property ${JSON.stringify(key)}`);
  }
}

function validateInteger(value, name, problems, minimum) {
  if (!Number.isInteger(value) || value < minimum) problems.push(`${name} must be an integer of at least ${minimum}`);
}

function validateStringArray(value, name, problems, options = {}) {
  if (!Array.isArray(value)) {
    problems.push(`${name} must be an array`);
    return;
  }
  if (value.length < (options.minimum ?? 0)) problems.push(`${name} must contain at least ${options.minimum} value(s)`);
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) {
      problems.push(`${name}[${index}] must be a non-empty string`);
      continue;
    }
    if (options.unique) {
      const normalized = item.normalize("NFKC").toLocaleLowerCase("en-US");
      if (seen.has(normalized)) problems.push(`${name}[${index}] duplicates an earlier value`);
      seen.add(normalized);
    }
  }
}

function validateProjectRelativePath(value, options = {}) {
  if (typeof value !== "string" || !value.trim()) return "must be a non-empty relative path";
  if (/\p{Cc}/u.test(value)) return "must not contain control characters";
  if (value.includes("\\")) return "must use forward slashes";
  if (/^(?:[A-Za-z]:|\/|~\/)/u.test(value)) return "must remain relative to the repository root";
  const segments = value.split("/").filter((segment) => segment !== "");
  if (segments.includes("..")) return "must not contain parent-directory traversal";
  if (!options.allowDot && (value === "." || value === "./")) return "must name a path below the repository root";
  if (options.requiredPrefix && !value.startsWith(options.requiredPrefix)) {
    return `must remain under ${options.requiredPrefix}`;
  }
  return null;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
