/* llmnav/1 module
id=llmnav.agent.tool-schema
role=Publish stable provider-neutral tool definitions without loading repository execution code.
owns=agent tool names|tool input schemas|tool order
excludes=operation execution|provider SDK transport|repository scope
search=agent tool definitions|tool JSON schema|stable tool prefix|provider neutral schema
rel=workflow>llmnav.agent.protocol
stability=contract
*/

export const AGENT_TOOL_SCHEMA_VERSION = 2;

// Duplicated from AUDIT_PRIORITIES on purpose: importing the audit module would load
// repository execution code into the definition-only surface. A contract test keeps them equal.
const AUDIT_PRIORITY_VALUES = Object.freeze(["high", "medium", "low"]);

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
  tool("llmnav_explain", "Explain one file's card coverage, audit evidence, disposition, and recommended next action.", {
    file: stringProperty("Repository-relative or repository-contained absolute file path."),
  }, ["file"]),
  tool("llmnav_audit", "List the highest-priority unannotated boundaries worth documenting next.", {
    priority: enumProperty("Lowest audit priority to include.", AUDIT_PRIORITY_VALUES, "low"),
    top: integerProperty("Maximum candidates.", 1, 50, 10),
  }),
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
