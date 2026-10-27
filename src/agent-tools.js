/* llmnav/1 module
id=llmnav.agent.tool-schema
role=Publish stable provider-neutral tool definitions without loading repository execution code.
owns=agent tool names|tool input schemas|tool order
excludes=operation execution|provider SDK transport|repository scope
search=agent tool definitions|tool JSON schema|stable tool prefix|provider neutral schema
rel=workflow>llmnav.agent.protocol
stability=contract
*/

import { AUDIT_LIMITS, DISCOVERY_SOURCE_LIMITS, METADATA_LIMITS, SEARCH_LIMITS } from "./policy.js";

export const AGENT_TOOL_SCHEMA_VERSION = 7;

// Duplicated from AUDIT_PRIORITIES on purpose: importing the audit module would load
// repository execution code into the definition-only surface. A contract test keeps them equal.
const AUDIT_PRIORITY_VALUES = Object.freeze(["high", "medium", "low"]);

const DEFINITIONS = [
  tool("llmnav_history", "Read file-level Git history and current staging/worktree state; dates never describe individual functions.", {
    file: stringProperty("Repository-relative file path from a navigation result."),
  }, ["file"]),
  tool("llmnav_query", "Find the most relevant semantic cards for a coding task.", {
    task: stringProperty("Task language to search for."),
    top: integerProperty("Maximum results.", SEARCH_LIMITS.top.minimum, SEARCH_LIMITS.top.maximum, SEARCH_LIMITS.top.default),
  }, ["task"]),
  tool("llmnav_show", "Resolve one local or qualified workspace semantic ID.", {
    id: stringProperty("Semantic ID or repository-qualified semantic ID."),
    metadata: { type: "boolean", description: "Include a bounded compiler metadata page.", default: false },
    members: { type: "boolean", description: "Page direct members instead of the declaration; requires metadata.", default: false },
    top: integerProperty("Metadata page size.", METADATA_LIMITS.top.minimum, METADATA_LIMITS.top.maximum, METADATA_LIMITS.top.default),
    offset: integerProperty("Metadata page offset.", 0, Number.MAX_SAFE_INTEGER, 0),
    metadataBudget: integerProperty("UTF-8 JSON bytes in the metadata page; excludes the existing show result.", METADATA_LIMITS.bytes.minimum, METADATA_LIMITS.bytes.maximum, METADATA_LIMITS.bytes.default),
  }, ["id"]),
  tool("llmnav_context", "Build bounded semantic and graph context around one ID.", {
    id: stringProperty("Semantic ID or repository-qualified semantic ID."),
    depth: integerProperty("Maximum graph traversal depth.", SEARCH_LIMITS.depth.minimum, SEARCH_LIMITS.depth.maximum, SEARCH_LIMITS.depth.default),
    budget: integerProperty("Approximate token budget.", SEARCH_LIMITS.budget.minimum, SEARCH_LIMITS.budget.maximum, SEARCH_LIMITS.budget.default),
    maxEdges: integerProperty("Maximum graph edges to inspect and pack.", SEARCH_LIMITS.maxEdges.minimum, SEARCH_LIMITS.maxEdges.maximum, SEARCH_LIMITS.maxEdges.default),
  }, ["id"]),
  tool("llmnav_check", "Validate semantic cards and configured graph inputs without mutation.", {
    paths: {
      type: "array",
      description: "Optional repository-relative paths to validate.",
      items: { type: "string", minLength: 1 },
      default: [],
    },
  }),
  tool("llmnav_explain", "Explain one file's card coverage, audit evidence, disposition, and recommended next action.", {
    file: stringProperty("Repository-relative or repository-contained absolute file path."),
  }, ["file"]),
  tool("llmnav_audit", "List the highest-priority unannotated boundaries worth documenting next.", {
    priority: enumProperty("Lowest audit priority to include.", AUDIT_PRIORITY_VALUES, "low"),
    top: integerProperty("Maximum candidates.", AUDIT_LIMITS.top.minimum, AUDIT_LIMITS.top.maximum, AUDIT_LIMITS.top.default),
  }),
  tool("llmnav_discover", "Locate live source without cards or an index. Use top:1 and includeSource:true to locate and read a candidate in one call; read more only if the excerpt is insufficient or truncated. Declaration boundaries are heuristic, not reviewed business rules.", {
    task: stringProperty("Source identifiers or task language to search for."),
    precise: { type: "boolean", description: "Use configured compiler definitions; reject stale analysis.", default: false },
    includeSource: { type: "boolean", description: "Include bounded live source excerpts; use these before another file read.", default: false },
    sourceBudget: integerProperty("Total UTF-8 source bytes across results; excludes JSON metadata.", DISCOVERY_SOURCE_LIMITS.minimum, DISCOVERY_SOURCE_LIMITS.maximum, DISCOVERY_SOURCE_LIMITS.default),
    top: integerProperty("Maximum results.", SEARCH_LIMITS.top.minimum, SEARCH_LIMITS.top.maximum, SEARCH_LIMITS.top.default),
  }, ["task"]),
];

export function getAgentToolDefinitions() {
  return structuredClone(DEFINITIONS);
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

function enumProperty(description, values, defaultValue) {
  return { type: "string", enum: [...values], default: defaultValue, description };
}

function integerProperty(description, minimum, maximum, defaultValue) {
  return { type: "integer", minimum, maximum, default: defaultValue, description };
}
