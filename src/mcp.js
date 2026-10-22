/* llmnav/1 module
id=llmnav.agent.mcp
role=Serve the stable agent tool schema and operation protocol over the Model Context Protocol stdio transport.
owns=JSON-RPC framing|capability negotiation|tool listing|tool call mapping|index snapshot reuse
excludes=agent tool schemas|operation execution|provider SDK transport|index preparation
search=mcp server|model context protocol|json rpc stdio|agent tool transport|session snapshot reuse
rel=workflow>llmnav.agent.tool-schema
rel=workflow>llmnav.agent.protocol
stability=contract
*/

import { once } from "node:events";
import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { executeAgentOperation, getAgentToolDefinitions } from "./agent-protocol.js";
import { createProjectSession } from "./search.js";
import { PACKAGE_VERSION } from "./spec.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "llmnav";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// Artifacts a prepared session depends on; the stamp decides when it reloads.
// The registry is included because active-ID merges rewrite it without a generation.
const SESSION_STAMP_FILES = [
  ".llmnav/cache/manifest.json",
  ".llmnav/cache/index.json",
  ".llmnav/cache/search-index.json",
  ".llmnav/cache/graph.json",
  ".llmnav/ids.jsonl",
];

export function createMcpServer(options = {}) {
  const root = options.root;
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("createMcpServer requires a project root path.");
  }
  const session = options.session ?? null;
  const sessionCache = options.session === undefined
    ? createSessionCache(root, { createSession: options.createSession })
    : null;
  const tools = getAgentToolDefinitions().map(toMcpTool);

  return {
    async handleLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return failure(null, PARSE_ERROR, "Parse error: the line is not valid JSON.");
      }
      return handleMessage(message, root, session, sessionCache, tools);
    },
    async handleMessage(message) {
      return handleMessage(message, root, session, sessionCache, tools);
    },
  };
}

async function handleMessage(message, root, session, sessionCache, tools) {
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

  if (message.method === "tools/call") return callTool(id, message.params, root, session, sessionCache);

  return failure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
}

async function callTool(id, params, root, session, sessionCache) {
  if (!hasToolName(params)) {
    return failure(id, INVALID_PARAMS, "Invalid params: tools/call requires a tool name.");
  }
  const input = params.arguments === undefined ? {} : params.arguments;
  const activeSession = await resolveSession(session, sessionCache);
  let envelope;
  try {
    envelope = await executeAgentOperation(
      root,
      params.name,
      input,
      activeSession === null ? {} : { session: activeSession },
    );
  } catch (error) {
    return failure(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
  }
  return success(id, {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: envelope.ok !== true,
  });
}

function hasToolName(params) {
  return params !== null && typeof params === "object" && !Array.isArray(params) &&
    typeof params.name === "string" && params.name.length > 0;
}

async function resolveSession(session, sessionCache) {
  if (sessionCache === null) return session;
  try {
    return await sessionCache.current();
  } catch {
    // A missing or half-written cache keeps the previous behaviour: one snapshot load per call.
    return null;
  }
}

export function createSessionCache(root, dependencies = {}) {
  const createSession = dependencies.createSession ?? createProjectSession;
  let session = null;
  let stamp = null;
  let loading = null;
  return {
    current() {
      // Concurrent calls share one load: a burst of tool calls must not each
      // rebuild the prepared index from disk.
      loading ??= load().finally(() => {
        loading = null;
      });
      return loading;
    },
  };

  async function load() {
    const nextStamp = await sessionStamp(root);
    if (session === null) {
      session = await createSession(root);
    } else if (nextStamp !== stamp) {
      // Generation rewrites the artifacts; reuse the prepared snapshot only while they are untouched.
      await session.refresh();
    }
    stamp = nextStamp;
    return session;
  }
}

/**
 * Identify the cache generation a prepared session was loaded from.
 *
 * Nanosecond timestamps and the file index are included, so a regeneration that
 * lands inside the same millisecond with an identical byte count is still seen.
 * `statFile` is injectable for tests.
 */
export async function sessionStamp(root, statFile = statCacheFile) {
  const parts = [];
  for (const relativePath of SESSION_STAMP_FILES) {
    const name = path.posix.basename(relativePath);
    const info = await statFile(path.join(root, relativePath));
    parts.push(info === null ? `${name}:missing` : `${name}:${info.mtimeNs}:${info.size}:${info.ino}`);
  }
  return parts.join("|");
}

async function statCacheFile(filePath) {
  try {
    return await stat(filePath, { bigint: true });
  } catch {
    return null;
  }
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
      if (response === null) continue;
      try {
        await writeWithBackpressure(output, `${JSON.stringify(response)}\n`);
      } catch (error) {
        // A host that closed the pipe is not a server failure.
        if (error && typeof error === "object" && error.code === "EPIPE") return 0;
        throw error;
      }
    }
  } finally {
    reader.close();
  }
  return 0;
}

async function writeWithBackpressure(output, text) {
  if (output.write(text) === true) return;
  // Ignoring the write result would buffer every response in memory; waiting for
  // drain or close keeps one request in flight.
  const closed = Promise.withResolvers();
  const onClose = () => closed.resolve(false);
  output.once("close", onClose);
  try {
    await Promise.race([once(output, "drain"), closed.promise]);
  } finally {
    output.removeListener("close", onClose);
  }
}
