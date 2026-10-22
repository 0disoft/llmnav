import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, getEventListeners, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createMcpServer, createSessionCache, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, serveMcpStdio, sessionStamp } from "../src/mcp.js";
import { getAgentToolDefinitions } from "../src/agent-protocol.js";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { queryProject } from "../src/search.js";
import { PACKAGE_VERSION } from "../src/spec.js";

const CLI = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));

test("request deadlines include a stalled shared session load", async () => {
  let expire;
  const server = createMcpServer({
    root: ".",
    createSession: () => new Promise(() => {}),
    scheduler: { setTimeout: (callback) => { expire = callback; return 1; }, clearTimeout() {} },
  });
  const pending = server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "llmnav_query", arguments: { task: "auth" } },
  });
  expire();
  const response = await pending;
  assert.equal(response.error.data.code, "LNV102");
});

test("rejects malformed frames without crashing the session", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-frames-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => createMcpServer({}), /requires a project root path/u);

  const server = createMcpServer({ root });
  const parseError = await server.handleLine("{ not json");
  assert.equal(parseError.id, null);
  assert.equal(parseError.error.code, -32700);

  const notAnObject = await server.handleLine("[]");
  assert.equal(notAnObject.error.code, -32600);

  const wrongVersion = await server.handleLine(JSON.stringify({ jsonrpc: "1.0", id: 7, method: "ping" }));
  assert.equal(wrongVersion.id, 7);
  assert.equal(wrongVersion.error.code, -32600);

  const missingArguments = await server.handleMessage({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} });
  assert.equal(missingArguments.error.code, -32602);

  const unknownMethod = await server.handleMessage({ jsonrpc: "2.0", id: 9, method: "llmnav/none" });
  assert.equal(unknownMethod.error.code, -32601);

  const notification = await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification, null);
});

test("serves the stable agent tool schema over JSON-RPC", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-schema-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const server = createMcpServer({ root });

  const initialized = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.deepEqual(initialized.result, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: MCP_SERVER_NAME, version: PACKAGE_VERSION },
  });

  const listed = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const expected = getAgentToolDefinitions();
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), expected.map((tool) => tool.name));
  for (const [index, tool] of listed.result.tools.entries()) {
    assert.deepEqual(Object.keys(tool), ["name", "description", "inputSchema"]);
    assert.deepEqual(tool.inputSchema, expected[index].inputSchema);
  }

  const ping = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual(ping.result, {});
});

test("executes agent operations over one stdio session in request order", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-session-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);

  const session = await runSession(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "llmnav_query", arguments: { task: "replayed refresh token", top: 3 } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "llmnav_show", arguments: { id: "missing.capability" } } },
    "{ truncated",
    { jsonrpc: "2.0", id: 5, method: "unknown/method" },
  ]);

  assert.equal(session.code, 0);
  assert.equal(session.err, "");
  const responses = session.out.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
  assert.deepEqual(responses.map((response) => response.id), [1, 2, 3, 4, null, 5]);
  assert.equal(responses[0].result.serverInfo.name, MCP_SERVER_NAME);

  const query = JSON.parse(responses[2].result.content[0].text);
  assert.equal(responses[2].result.isError, false);
  assert.equal(query.operation, "query");
  assert.equal(query.data[0].id, "auth.session.rotate");

  const missing = JSON.parse(responses[3].result.content[0].text);
  assert.equal(responses[3].result.isError, true);
  assert.equal(missing.error.code, "LNVAP404");
  assert.equal(missing.operation, "show");
});

test("reuses one index snapshot across calls and picks up regenerated indexes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-reuse-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const server = createMcpServer({ root });

  const first = await callTool(server, 1, "llmnav_query", { task: "replayed refresh token", top: 3 });
  assert.equal(first.data[0].id, "auth.session.rotate");
  const repeated = await callTool(server, 2, "llmnav_query", { task: "replayed refresh token", top: 3 });
  assert.deepEqual(repeated, first);

  await writeFile(
    path.join(root, "src", "billing.ts"),
    `/* llmnav/1 symbol
id=auth.billing.issue
role=Issue one billing invoice for an account.
search=billing invoice|invoice issuance
stability=implementation
*/
export function issueInvoice(): void {}
`,
  );
  await generateProject(root);

  const refreshed = await callTool(server, 3, "llmnav_query", { task: "billing invoice", top: 3 });
  assert.ok(refreshed.data.some((card) => card.id === "auth.billing.issue"));
  const direct = await queryProject(root, "billing invoice", { top: 3 });
  assert.deepEqual(refreshed.data.map((card) => card.id), direct.map((card) => card.id));
});

test("concurrent tool calls share one snapshot load", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-single-flight-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let created = 0;
  let refreshed = 0;
  const session = { refresh: async () => { refreshed += 1; } };
  const gate = Promise.withResolvers();
  const cache = createSessionCache(root, {
    createSession: async () => {
      created += 1;
      await gate.promise;
      return session;
    },
  });
  const pending = Promise.all([cache.current(), cache.current(), cache.current()]);
  gate.resolve();
  const loaded = await pending;
  assert.equal(created, 1);
  assert.equal(refreshed, 0);
  for (const value of loaded) assert.equal(value, session);
  assert.equal(await cache.current(), session);
  assert.equal(created, 1);
});

test("stdio output applies backpressure before reading the next request", async () => {
  const writes = [];
  const output = new EventEmitter();
  output.write = (text) => {
    writes.push(text);
    return writes.length > 1;
  };
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`,
  ]);
  const serving = serveMcpStdio({ root: os.tmpdir(), input, output });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes.length, 1);
  output.emit("drain");
  assert.equal(await serving, 0);
  assert.equal(writes.length, 2);
});

test("output waits release every listener after drain, close, error, or cancellation", { timeout: 15000 }, async () => {
  for (const ending of ["drain", "close", "error", "abort"]) {
    const input = new PassThrough();
    const output = new EventEmitter();
    const controller = new AbortController();
    const written = Promise.withResolvers();
    output.write = () => { written.resolve(); return false; };
    const serving = serveMcpStdio({ root: os.tmpdir(), input, output, signal: controller.signal });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await written.promise;
    const reason = new Error(ending);
    if (ending === "abort") controller.abort(reason);
    else if (ending === "error") output.emit("error", reason);
    else {
      output.emit(ending);
      input.end();
    }
    if (ending === "abort" || ending === "error") await assert.rejects(serving, error => error === reason);
    else assert.equal(await serving, 0);
    for (const event of ["drain", "close", "error"]) assert.equal(output.listenerCount(event), 0, `${ending}: ${event}`);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    if (ending === "abort" || ending === "error") assert.equal(input.destroyed, false);
    input.destroy();
  }
});

test("stdio cancellation closes an idle reader and handles already-closed output", { timeout: 15000 }, async () => {
  const controller = new AbortController();
  const input = new PassThrough();
  const output = new EventEmitter();
  output.write = () => true;
  const serving = serveMcpStdio({ root: os.tmpdir(), input, output, signal: controller.signal });
  const reason = new Error("stop idle server");
  controller.abort(reason);
  await assert.rejects(serving, error => error === reason);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  output.closed = true;
  assert.equal(await serveMcpStdio({ root: os.tmpdir(), input, output }), 0);
  for (const event of ["drain", "close", "error"]) assert.equal(output.listenerCount(event), 0);
  input.destroy();
});

test("synchronous output closure is observed before the write returns", async () => {
  const output = new EventEmitter();
  output.write = () => { output.emit("close"); return false; };
  const input = Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']);
  assert.equal(await serveMcpStdio({ root: os.tmpdir(), input, output }), 0);
  for (const event of ["drain", "close", "error"]) assert.equal(output.listenerCount(event), 0);
});

test("a closed stdio output ends the session without an error", async () => {
  const output = new EventEmitter();
  output.write = () => {
    throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
  };
  const input = Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`]);
  assert.equal(await serveMcpStdio({ root: os.tmpdir(), input, output }), 0);
});

test("cache stamps separate regenerations inside one millisecond", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-stamp-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePathFor = (filePath) => path.basename(filePath);
  const files = new Map([
    ["manifest.json", { mtimeNs: 1_000_000n, size: 10n, ino: 7n }],
    ["index.json", { mtimeNs: 1_000_000n, size: 20n, ino: 7n }],
    ["search-index.json", { mtimeNs: 1_000_000n, size: 30n, ino: 7n }],
    ["graph.json", null],
  ]);
  const readStamp = () => sessionStamp(root, async (filePath) => files.get(filePathFor(filePath)) ?? null);

  const baseStamp = await readStamp();
  assert.equal(
    baseStamp,
    "cache=.llmnav/cache|manifest.json:1000000:10:7|index.json:1000000:20:7|search-index.json:1000000:30:7|graph.json:missing|config.json:missing|lexicon.json:missing|ids.jsonl:missing",
  );
  assert.equal(await readStamp(), baseStamp);

  files.set("search-index.json", { mtimeNs: 1_000_001n, size: 30n, ino: 7n });
  assert.notEqual(await readStamp(), baseStamp);
  files.set("search-index.json", { mtimeNs: 1_000_000n, size: 30n, ino: 8n });
  assert.notEqual(await readStamp(), baseStamp);

  // Registering active IDs rewrites the registry without touching the cache.
  files.set("ids.jsonl", { mtimeNs: 1_000_000n, size: 40n, ino: 7n });
  assert.match(await readStamp(), /\|ids\.jsonl:1000000:40:7$/u);
  const beforeLexicon = await readStamp();
  files.set("lexicon.json", { mtimeNs: 2_000_000n, size: 40n, ino: 7n });
  assert.notEqual(await readStamp(), beforeLexicon);
});

test("MCP refreshes lexicon-only changes and generations in a configured cache directory", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-cache-inputs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const server = createMcpServer({ root });
  assert.deepEqual((await callTool(server, 1, "llmnav_query", { task: "quuxzz" })).data, []);
  await writeFile(path.join(root, ".llmnav", "lexicon.json"), JSON.stringify({ version: 1, aliases: { quuxzz: "auth.session.rotate" } }));
  assert.equal((await callTool(server, 2, "llmnav_query", { task: "quuxzz" })).data[0].id, "auth.session.rotate");

  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.generation.cacheDirectory = ".llmnav/custom-cache";
  await writeFile(configPath, JSON.stringify(config));
  assert.equal((await generateProject(root)).ok, true);
  await callTool(server, 3, "llmnav_query", { task: "quuxzz" });
  const sourcePath = path.join(root, "src", "rotate.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("Rotate one refresh-token family and reject replayed tokens.", "Reserve qzxbeta credits before dispatch."));
  assert.equal((await generateProject(root)).ok, true);
  const result = (await callTool(server, 4, "llmnav_query", { task: "qzxbeta" })).data;
  assert.equal(result[0].id, "auth.session.rotate");
  assert.deepEqual(result, await queryProject(root, "qzxbeta"));
});

test("a failed artifact stat is reported instead of looking missing", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-stat-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });

  await assert.rejects(sessionStamp(root, async () => {
    throw denied;
  }), (error) => {
    assert.equal(error.code, "LNV100");
    assert.equal(error.retryable, true);
    assert.equal(error.cause, denied);
    return true;
  });
});

test("tool calls report a failed snapshot load with its cause", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-cause-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const denied = Object.assign(new Error("snapshot unavailable"), { code: "EACCES" });
  const server = createMcpServer({
    root,
    createSession: async () => {
      throw denied;
    },
  });

  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "llmnav_query", arguments: { task: "auth" } },
  });
  assert.equal(response.error.code, -32603);
  assert.equal(response.error.message, "snapshot unavailable");
  assert.deepEqual(response.error.data, { code: "EACCES", retryable: true, cause: [] });
});

test("a tool call that outlives its request deadline reports a timeout", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-deadline-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(
    () => createMcpServer({ root, requestTimeoutMs: -1 }),
    /requires a non-negative integer requestTimeoutMs/u,
  );

  const server = createMcpServer({
    root,
    requestTimeoutMs: 10,
    session: { query: () => new Promise(() => {}) },
  });
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "llmnav_query", arguments: { task: "auth" } },
  });
  assert.equal(response.error.code, -32603);
  assert.equal(response.error.data.code, "LNV102");
  assert.equal(response.error.data.retryable, false);
  assert.match(response.error.message, /did not finish within 10 ms/u);
});

async function callTool(server, id, name, args) {
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.equal(response.id, id);
  const envelope = JSON.parse(response.result.content[0].text);
  assert.equal(envelope.ok, true, envelope.error?.message);
  return envelope;
}

async function runSession(root, lines) {
  const child = spawn(process.execPath, [CLI, "mcp", "--root", root], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const closed = once(child, "close");
  child.stdin.end(lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line)) + "\n").join(""));
  const [code] = await closed;
  return { code, out, err };
}

async function createProject(root) {
  await writeFile(path.join(root, "package.json"), '{"name":"mcp-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "rotate.ts"),
    `/* llmnav/1 symbol
id=auth.session.rotate
role=Rotate one refresh-token family and reject replayed tokens.
search=refresh token|token rotation|replay detection
stability=contract
*/
export function rotateSession(): void {}
`,
  );
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
}
