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

import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { executeAgentOperation, getAgentToolDefinitions } from "./agent-protocol.js";
import { createIoError, DEFAULT_REQUEST_TIMEOUT_MS, toErrorPayload, withDeadline } from "./errors.js";
import { createProjectSession } from "./search.js";
import { PACKAGE_VERSION } from "./spec.js";
import { abortable, assertAbortSignal, createAbortError, throwIfAborted } from "./abort.js";
import { loadConfig } from "./config.js";
import { MAX_TIMER_DELAY_MS } from "./runtime.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "llmnav";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// Artifacts a prepared session depends on; the stamp decides when it reloads.
// The registry is included because active-ID merges rewrite it without a generation.
const SESSION_CACHE_FILES = ["manifest.json", "index.json", "search-index.json", "graph.json"];

export function createMcpServer(options = {}) {
  const root = options.root;
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("createMcpServer requires a project root path.");
  }
  const session = options.session ?? null;
  const sessionCache = options.session === undefined
    ? createSessionCache(root, {
      createSession: options.createSession,
      loadTimeoutMs: options.sessionLoadTimeoutMs,
      signal: options.signal,
      scheduler: options.scheduler,
    })
    : null;
  const tools = getAgentToolDefinitions().map(toMcpTool);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 0 || requestTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`createMcpServer requires a non-negative integer requestTimeoutMs: ${requestTimeoutMs}.`);
  }

  return {
    async handleLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return failure(null, PARSE_ERROR, "Parse error: the line is not valid JSON.");
      }
      return handleMessage(message, root, session, sessionCache, tools, requestTimeoutMs, options);
    },
    async handleMessage(message) {
      return handleMessage(message, root, session, sessionCache, tools, requestTimeoutMs, options);
    },
  };
}

async function handleMessage(message, root, session, sessionCache, tools, requestTimeoutMs, options) {
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
    return callTool(id, message.params, root, session, sessionCache, requestTimeoutMs, options);
  }

  return failure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
}

async function callTool(id, params, root, session, sessionCache, requestTimeoutMs, options) {
  if (!hasToolName(params)) {
    return failure(id, INVALID_PARAMS, "Invalid params: tools/call requires a tool name.");
  }
  const input = params.arguments === undefined ? {} : params.arguments;
  let envelope;
  const controller = new AbortController();
  try {
    throwIfAborted(options.signal);
    const operation = Promise.resolve().then(async () => {
      const activeSession = await resolveSession(session, sessionCache, controller.signal);
      throwIfAborted(controller.signal);
      return executeAgentOperation(root, params.name, input, {
        ...(activeSession === null ? {} : { session: activeSession }),
        signal: controller.signal,
      });
    });
    envelope = await withDeadline(`${params.name} request`, requestTimeoutMs, operation, options);
  } catch (error) {
    controller.abort(error);
    return failure(
      id,
      INTERNAL_ERROR,
      error instanceof Error ? error.message : String(error),
      toErrorPayload(error),
    );
  } finally {
    controller.abort();
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

async function resolveSession(session, sessionCache, signal) {
  if (sessionCache === null) return session;
  // A failed snapshot load is reported by the caller: reusing a stale snapshot
  // silently answers with data that no longer matches the repository.
  return sessionCache.current({ signal });
}

export function createSessionCache(root, dependencies = {}) {
  const createSession = dependencies.createSession ?? createProjectSession;
  const readStamp = dependencies.sessionStamp ?? sessionStamp;
  const timeoutMs = dependencies.loadTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError("Session loadTimeoutMs must be an integer between 0 and 2147483647.");
  }
  assertAbortSignal(dependencies.signal);
  let session = null;
  let stamp = null;
  let loading = null;
  return {
    current(options = {}) {
      assertAbortSignal(options.signal);
      throwIfAborted(options.signal);
      throwIfAborted(dependencies.signal);
      loading ??= startLoad();
      // A request may stop waiting without cancelling other subscribers.
      return options.signal === undefined ? loading.promise : abortable(loading.promise, options.signal);
    },
  };

  function startLoad() {
    const controller = new AbortController();
    const onAbort = () => controller.abort(createAbortError(dependencies.signal));
    dependencies.signal?.addEventListener("abort", onAbort);
    if (dependencies.signal?.aborted) onAbort();
    const record = { promise: null };
    const work = Promise.resolve().then(() => load(controller.signal));
    record.promise = withDeadline("MCP session load", timeoutMs, work, {
      signal: controller.signal, scheduler: dependencies.scheduler,
    }).catch(error => {
      controller.abort(error);
      // Detach a possibly half-refreshed instance before admitting a new load.
      session = null;
      stamp = null;
      throw error;
    }).finally(() => {
      dependencies.signal?.removeEventListener?.("abort", onAbort);
      if (loading === record) loading = null;
    });
    return record;
  }

  async function load(signal) {
    const previous = session;
    const previousStamp = stamp;
    const nextStamp = await abortable(readStamp(root, undefined, { signal }), signal);
    throwIfAborted(signal);
    const next = previous ?? await createSession(root, { signal });
    if (previous !== null && nextStamp !== previousStamp) await previous.refresh({ signal });
    // A late completion from an abandoned load cannot publish its snapshot.
    throwIfAborted(signal);
    session = next;
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
export async function sessionStamp(root, statFile = statCacheFile, options = {}) {
  const { config } = await loadConfig(root, options);
  const cacheDirectory = config.generation.cacheDirectory.replaceAll("\\", "/");
  const files = [
    ...SESSION_CACHE_FILES.map((name) => `${cacheDirectory}/${name}`),
    ".llmnav/config.json",
    ".llmnav/lexicon.json",
    ".llmnav/ids.jsonl",
  ];
  const parts = [`cache=${cacheDirectory}`];
  for (const relativePath of files) {
    const name = path.posix.basename(relativePath);
    let info;
    try {
      info = await abortable(statFile(path.join(root, relativePath)), options.signal);
    } catch (error) {
      // A stat that fails for any reason other than absence must not look like a
      // missing artifact, or the session silently stops noticing regeneration.
      throwIfAborted(options.signal);
      throw createIoError("stat", name, error);
    }
    parts.push(info === null ? `${name}:missing` : `${name}:${info.mtimeNs}:${info.size}:${info.ino}`);
  }
  return parts.join("|");
}

async function statCacheFile(filePath) {
  try {
    return await stat(filePath, { bigint: true });
  } catch (error) {
    // Absence is the only failure that means "missing"; sessionStamp wraps the rest.
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
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

function failure(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export async function serveMcpStdio(options = {}) {
  assertAbortSignal(options.signal);
  throwIfAborted(options.signal);
  const controller = new AbortController();
  const server = createMcpServer({ ...options, signal: controller.signal });
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const stop = (reason) => { controller.abort(reason); reader.close(); };
  const onAbort = () => stop(createAbortError(options.signal));
  const onClose = () => stop(closedOutputError());
  const onError = (error) => stop(error);
  try {
    options.signal?.addEventListener("abort", onAbort);
    output.on("close", onClose);
    output.on("error", onError);
    if (options.signal?.aborted) onAbort();
    if (output.destroyed || output.closed || output.writableEnded) onClose();
    throwIfAborted(controller.signal);
    for await (const line of reader) {
      throwIfAborted(controller.signal);
      if (line.trim().length === 0) continue;
      const response = await server.handleLine(line);
      if (response !== null) await writeWithBackpressure(output, `${JSON.stringify(response)}\n`, controller.signal);
    }
    throwIfAborted(controller.signal);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPIPE") return 0;
    throw error;
  } finally {
    controller.abort();
    reader.close();
    options.signal?.removeEventListener?.("abort", onAbort);
    output.removeListener("close", onClose);
    output.removeListener("error", onError);
  }
  return 0;
}

function closedOutputError() {
  return Object.assign(new Error("MCP output is closed."), { code: "EPIPE" });
}

async function writeWithBackpressure(output, text, signal) {
  let onDrain, onClose, onError, onAbort;
  try {
    await new Promise((resolve, reject) => {
      onDrain = resolve;
      onClose = () => reject(closedOutputError());
      onError = reject;
      onAbort = () => reject(createAbortError(signal));
      // Subscribe before writing: custom streams can close or drain synchronously.
      output.once("drain", onDrain);
      output.once("close", onClose);
      output.once("error", onError);
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) return onAbort();
      if (output.destroyed || output.closed || output.writableEnded) return onClose();
      if (output.write(text) === true) resolve();
    });
  } finally {
    output.removeListener("drain", onDrain);
    output.removeListener("close", onClose);
    output.removeListener("error", onError);
    signal.removeEventListener("abort", onAbort);
  }
}
