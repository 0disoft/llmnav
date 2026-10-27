/* llmnav/1 module
id=llmnav.agent.protocol
role=Execute bounded repository navigation operations through one provider-neutral result envelope.
owns=operation validation|operation dispatch|operation handler table|provider-neutral result envelope
excludes=provider SDK transport|repository discovery|source mutation
search=agent tool schema|provider neutral tools|tool dispatcher|agent operation protocol
rel=workflow>llmnav.search.query
rel=workflow>llmnav.rules.validate
rel=workflow>llmnav.audit.coverage
stability=contract
*/

import { discoverProject } from "./discovery.js";
import { loadGraphInputs } from "./graph-input.js";
import { scanProject } from "./project.js";
import { buildContext, queryProject, SemanticIdLookupError, showProjectCard } from "./search.js";
import { countDiagnostics, validateProject } from "./validator.js";
import { getAgentToolDefinitions } from "./agent-tools.js";
import { auditProject, explainProjectFile, selectAuditCandidates } from "./audit.js";
import { AUDIT_LIMITS, SEARCH_LIMITS } from "./policy.js";
import { toErrorPayload } from "./errors.js";
import { throwIfAborted } from "./abort.js";
import { validateMetadataOptions } from "./code-metadata.js";

export { AGENT_TOOL_SCHEMA_VERSION, getAgentToolDefinitions } from "./agent-tools.js";
export const AGENT_OPERATION_SCHEMA_VERSION = 1;

// Public wire contract: hosts branch on these codes, so keep them in one table.
export const AGENT_OPERATION_ERROR_CODES = Object.freeze({
  unknownOperation: "LNVAP001",
  invalidInput: "LNVAP002",
  notFound: "LNVAP404",
  ambiguous: "LNVAP409",
  internal: "LNVAP500",
});

const DEFINITIONS = getAgentToolDefinitions();

const OPERATIONS = new Map([
  ["llmnav_query", "query"],
  ["llmnav_discover", "discover"],
  ["llmnav_show", "show"],
  ["llmnav_context", "context"],
  ["llmnav_check", "check"],
  ["llmnav_explain", "explain"],
  ["llmnav_audit", "audit"],
]);

// Validation runs once in resolveRequest; handlers only execute work and report failure kinds.
const OPERATION_HANDLERS = new Map([
  ["query", handleQuery],
  ["discover", handleDiscover],
  ["show", handleShow],
  ["context", handleContext],
  ["check", handleCheck],
  ["explain", handleExplain],
  ["audit", handleAudit],
]);

export async function executeAgentOperation(root, name, input = {}, options = {}) {
  const request = resolveRequest(name, input);
  if (request.failure) return request.failure;
  try {
    throwIfAborted(options.signal);
    const outcome = await OPERATION_HANDLERS.get(request.operation)(input, root, options);
    throwIfAborted(options.signal);
    if (outcome.failure) {
      return failure(request.operation, outcome.failure.code, outcome.failure.message, outcome.failure.data ?? null);
    }
    return success(request.operation, outcome.data, outcome.ok !== false);
  } catch (error) {
    return failure(request.operation, errorCodeFor(error), errorMessage(error), null, toErrorPayload(error));
  }
}

function resolveRequest(name, input) {
  const canonicalName = String(name);
  const operation = OPERATIONS.get(canonicalName);
  if (!operation) {
    return {
      failure: failure(
        "unknown",
        AGENT_OPERATION_ERROR_CODES.unknownOperation,
        `Unknown agent operation ${JSON.stringify(name)}.`,
      ),
    };
  }
  const definition = DEFINITIONS.find((item) => item.name === canonicalName);
  const validationError = validateInput(definition.inputSchema, input);
  if (validationError) {
    return { failure: failure(operation, AGENT_OPERATION_ERROR_CODES.invalidInput, validationError) };
  }
  if (operation === "show") {
    try { validateMetadataOptions(input); }
    catch (error) { return { failure: failure(operation, AGENT_OPERATION_ERROR_CODES.invalidInput, error.message) }; }
  }
  return { operation };
}

async function handleDiscover(input, root, options) {
  return { data: await discoverProject(root, input.task.trim(), { ...options, top: input.top ?? SEARCH_LIMITS.top.default,
    precise: input.precise === true, includeSource: input.includeSource === true, sourceBudget: input.sourceBudget }) };
}

async function handleQuery(input, root, options) {
  const task = input.task.trim();
  const top = input.top ?? SEARCH_LIMITS.top.default;
  const data = options.session
    ? await options.session.query(task, { top, ...(options.signal ? { signal: options.signal } : {}) })
    : await queryProject(root, task, { ...options, top });
  return { data };
}

async function handleShow(input, root, options) {
  options = { ...options, metadata: input.metadata, members: input.members, top: input.top, offset: input.offset, metadataBudget: input.metadataBudget };
  const result = options.session
    ? await options.session.show(input.id.trim(), options)
    : await showProjectCard(root, input.id.trim(), options);
  if (result.card || result.node) return { data: result };
  const state = result.resolvedFrom?.state;
  if (state === "ambiguous") {
    return {
      failure: {
        code: AGENT_OPERATION_ERROR_CODES.ambiguous,
        message: `Ambiguous semantic ID ${input.id}; qualify or replace it with one candidate.`,
        data: result,
      },
    };
  }
  if (state === "cycle") {
    return {
      failure: {
        code: AGENT_OPERATION_ERROR_CODES.internal,
        message: `Registry cycle prevents resolving semantic ID ${input.id}.`,
        data: result,
      },
    };
  }
  return {
    failure: {
      code: AGENT_OPERATION_ERROR_CODES.notFound,
      message: `Unknown or inactive semantic ID ${input.id}.`,
      data: result,
    },
  };
}

async function handleContext(input, root, options) {
  const { session, ...executionOptions } = options;
  const contextOptions = {
    ...executionOptions,
    depth: input.depth ?? SEARCH_LIMITS.depth.default,
    budget: input.budget ?? SEARCH_LIMITS.budget.default,
    maxEdges: input.maxEdges ?? SEARCH_LIMITS.maxEdges.default,
  };
  const data = options.session
    ? await options.session.context(input.id.trim(), contextOptions)
    : await buildContext(root, input.id.trim(), contextOptions);
  return { data };
}

async function handleAudit(input, root, options) {
  const minimumPriority = input.priority ?? "low";
  const result = await auditProject(root, options);
  const selected = selectAuditCandidates(result, minimumPriority, input.top ?? AUDIT_LIMITS.top.default);
  return {
    data: {
      repositoryId: result.repositoryId,
      minimumPriority,
      summary: result.summary,
      candidates: selected.candidates.map(toAuditCandidate),
      matched: selected.matched,
      truncated: selected.truncated,
    },
  };
}

async function handleExplain(input, root, options) {
  throwIfAborted(options.signal);
  return { data: await explainProjectFile(root, input.file.trim(), options) };
}

async function handleCheck(input, root, options) {
  const registry = options.session ? options.session.registrySnapshot() : undefined;
  const project = await scanProject(root, {
    ...options,
    paths: input.paths ?? [],
    ...(registry === undefined ? {} : { registry }),
  });
  const graphInputs = await loadGraphInputs(root, project.config, options);
  const diagnostics = [...validateProject(project), ...graphInputs.diagnostics].sort(compareDiagnostics);
  const counts = countDiagnostics(diagnostics);
  return { data: { counts, diagnostics, cardCount: project.records.length }, ok: counts.error === 0 };
}

function errorCodeFor(error) {
  if (!(error instanceof SemanticIdLookupError)) return AGENT_OPERATION_ERROR_CODES.internal;
  if (error.reason === "not_found") return AGENT_OPERATION_ERROR_CODES.notFound;
  if (error.reason === "ambiguous") return AGENT_OPERATION_ERROR_CODES.ambiguous;
  return AGENT_OPERATION_ERROR_CODES.internal;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function validateInput(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Operation input must be an object.";
  const keys = Object.keys(input).sort();
  const unknown = keys.filter((key) => !Object.hasOwn(schema.properties, key));
  if (unknown.length > 0) return `Unknown input field(s): ${unknown.join(", ")}.`;
  const missing = schema.required.filter((key) => input[key] === undefined);
  if (missing.length > 0) return `Missing required input field(s): ${missing.join(", ")}.`;
  for (const key of keys) {
    const error = validateProperty(key, input[key], schema.properties[key]);
    if (error) return error;
  }
  return null;
}

function validateProperty(key, value, schema) {
  if (schema.type === "string") {
    if (typeof value !== "string" || value.trim().length < (schema.minLength ?? 0)) return `Input field ${key} must be a non-empty string.`;
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
      return `Input field ${key} must be one of: ${schema.enum.join(", ")}.`;
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") return `Input field ${key} must be a boolean.`;
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) {
      return `Input field ${key} must be an integer from ${schema.minimum} to ${schema.maximum}.`;
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length < schema.items.minLength)) {
      return `Input field ${key} must be an array of non-empty strings.`;
    }
  }
  return null;
}

function success(operation, data, ok = true) {
  return { schemaVersion: AGENT_OPERATION_SCHEMA_VERSION, operation, ok, data, error: null };
}

function failure(operation, code, message, data = null, details = undefined) {
  const error = details === undefined ? { code, message } : { code, message, data: details };
  return { schemaVersion: AGENT_OPERATION_SCHEMA_VERSION, operation, ok: false, data, error };
}

function toAuditCandidate(candidate) {
  return {
    path: candidate.path,
    priority: candidate.priority,
    score: candidate.score,
    reasons: candidate.reasons,
    suggestedCoverageRule: candidate.suggestedCoverageRule,
  };
}

function compareDiagnostics(left, right) {
  return left.file.localeCompare(right.file, "en") || left.line - right.line || left.column - right.column ||
    left.code.localeCompare(right.code, "en") || left.message.localeCompare(right.message, "en");
}
