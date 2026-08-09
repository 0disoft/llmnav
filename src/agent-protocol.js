/* llmnav/1 module
id=llmnav.agent.protocol
role=Expose stable provider-neutral tool schemas and execute bounded repository navigation operations.
owns=agent tool schemas|operation validation|provider-neutral result envelope
excludes=provider SDK transport|repository discovery|source mutation
search=agent tool schema|provider neutral tools|tool dispatcher|agent operation protocol
rel=workflow>llmnav.search.query
rel=workflow>llmnav.rules.validate
stability=contract
*/

import { loadGraphInputs } from "./graph-input.js";
import { scanProject } from "./project.js";
import { buildContext, queryProject, showProjectCard } from "./search.js";
import { countDiagnostics, validateProject } from "./validator.js";

export const AGENT_TOOL_SCHEMA_VERSION = 1;
export const AGENT_OPERATION_SCHEMA_VERSION = 1;

const DEFINITIONS = [
  tool("llmnav_query", "Find the most relevant semantic cards for a coding task.", {
    task: stringProperty("Task language to search for."),
    top: integerProperty("Maximum results.", 1, 100, 5),
  }, ["task"]),
  tool("llmnav_show", "Resolve one local or qualified workspace semantic ID.", {
    id: stringProperty("Semantic ID or repository-qualified semantic ID."),
  }, ["id"]),
  tool("llmnav_context", "Build bounded semantic and graph context around one ID.", {
    id: stringProperty("Semantic ID or repository-qualified semantic ID."),
    depth: integerProperty("Maximum graph traversal depth.", 0, 8, 1),
    budget: integerProperty("Approximate token budget.", 128, 100000, 2500),
    maxEdges: integerProperty("Maximum graph edges to inspect and pack.", 0, 1000, 24),
  }, ["id"]),
  tool("llmnav_check", "Validate semantic cards and configured graph inputs without mutation.", {
    paths: {
      type: "array",
      description: "Optional repository-relative paths to validate.",
      items: { type: "string", minLength: 1 },
      default: [],
    },
  }),
];

const OPERATIONS = new Map([
  ["llmnav_query", "query"],
  ["llmnav_show", "show"],
  ["llmnav_context", "context"],
  ["llmnav_check", "check"],
]);

export function getAgentToolDefinitions() {
  return structuredClone(DEFINITIONS);
}

export async function executeAgentOperation(root, name, input = {}) {
  const canonicalName = String(name);
  const operation = OPERATIONS.get(canonicalName);
  if (!operation) return failure("unknown", "LNVAP001", `Unknown agent operation ${JSON.stringify(name)}.`);
  const definition = DEFINITIONS.find((item) => item.name === canonicalName);
  const validationError = validateInput(definition.inputSchema, input);
  if (validationError) return failure(operation, "LNVAP002", validationError);

  try {
    if (operation === "query") {
      return success(operation, await queryProject(root, input.task.trim(), { top: input.top ?? 5 }));
    }
    if (operation === "show") {
      const result = await showProjectCard(root, input.id.trim());
      if (!result.card && !result.node) return failure(operation, "LNVAP404", `Unknown or inactive semantic ID ${input.id}.`, result);
      return success(operation, result);
    }
    if (operation === "context") {
      return success(operation, await buildContext(root, input.id.trim(), {
        depth: input.depth ?? 1,
        budget: input.budget ?? 2500,
        maxEdges: input.maxEdges ?? 24,
      }));
    }
    const project = await scanProject(root, { paths: input.paths ?? [] });
    const graphInputs = await loadGraphInputs(root, project.config);
    const diagnostics = [...validateProject(project), ...graphInputs.diagnostics].sort(compareDiagnostics);
    const counts = countDiagnostics(diagnostics);
    return {
      schemaVersion: AGENT_OPERATION_SCHEMA_VERSION,
      operation,
      ok: counts.error === 0,
      data: { counts, diagnostics, cardCount: project.records.length },
      error: null,
    };
  } catch (error) {
    return failure(operation, "LNVAP500", error instanceof Error ? error.message : String(error));
  }
}

function tool(name, description, properties, required = []) {
  return {
    schemaVersion: AGENT_TOOL_SCHEMA_VERSION,
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
  };
}

function stringProperty(description) {
  return { type: "string", minLength: 1, description };
}

function integerProperty(description, minimum, maximum, defaultValue) {
  return { type: "integer", minimum, maximum, default: defaultValue, description };
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

function success(operation, data) {
  return { schemaVersion: AGENT_OPERATION_SCHEMA_VERSION, operation, ok: true, data, error: null };
}

function failure(operation, code, message, data = null) {
  return { schemaVersion: AGENT_OPERATION_SCHEMA_VERSION, operation, ok: false, data, error: { code, message } };
}

function compareDiagnostics(left, right) {
  return left.file.localeCompare(right.file, "en") || left.line - right.line || left.column - right.column ||
    left.code.localeCompare(right.code, "en") || left.message.localeCompare(right.message, "en");
}
