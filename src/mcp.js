/* llmnav/1 module
id=llmnav.agent.mcp
role=Serve the stable agent tool schema and operation protocol over the Model Context Protocol stdio transport.
owns=JSON-RPC framing|capability negotiation|tool listing|tool call mapping
excludes=agent tool schemas|operation execution|provider SDK transport
search=mcp server|model context protocol|json rpc stdio|agent tool transport
rel=workflow>llmnav.agent.tool-schema
rel=workflow>llmnav.agent.protocol
stability=contract
*/

import readline from "node:readline";
import { executeAgentOperation, getAgentToolDefinitions } from "./agent-protocol.js";
import { PACKAGE_VERSION } from "./spec.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "llmnav";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export function createMcpServer(options = {}) {
  const root = options.root;
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("createMcpServer requires a project root path.");
  }
  const session = options.session ?? null;
  const tools = getAgentToolDefinitions().map(toMcpTool);

  return {
    async handleLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return failure(null, PARSE_ERROR, "Parse error: the line is not valid JSON.");
      }
      return handleMessage(message, root, session, tools);
    },
    async handleMessage(message) {
      return handleMessage(message, root, session, tools);
    },
  };
}

async function handleMessage(message, root, session, tools) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return failure(null, INVALID_REQUEST, "Invalid Request: expected a JSON-RPC object.");
  }
  const notification = !Object.hasOwn(message, "id");
  const id = notification ? null : message.id;
  if (message.jsonrpc !== "2.0") {
    return failure(id, INVALID_REQUEST, "Invalid Request: jsonrpc must be \"2.0\".");
  }
  if (typeof message.method !== "string" || message.method.length === 0) {
    return failure(id, INVALID_REQUEST, "Invalid Request: method must be a non-empty string.");
  }
  if (notification) return null;

  if (message.method === "initialize") {
    return success(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: PACKAGE_VERSION },
    });
  }
  if (message.method === "ping") return success(id, {});
  if (message.method === "tools/list") return success(id, { tools });

  if (message.method === "tools/call") {
    const params = message.params;
    if (params === null || typeof params !== "object" || Array.isArray(params) || typeof params.name !== "string" || params.name.length === 0) {
      return failure(id, INVALID_PARAMS, "Invalid params: tools/call requires a tool name.");
    }
    const input = params.arguments === undefined ? {} : params.arguments;
    let envelope;
    try {
      envelope = await executeAgentOperation(
        root,
        params.name,
        input,
        session === null ? {} : { session },
      );
    } catch (error) {
      return failure(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    }
    return success(id, {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      isError: envelope.ok !== true,
    });
  }

  return failure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
}

function toMcpTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function serveMcpStdio(options = {}) {
  const server = createMcpServer(options);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line.trim().length === 0) continue;
      const response = await server.handleLine(line);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    reader.close();
  }
  return 0;
}
