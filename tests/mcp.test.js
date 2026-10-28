import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, getEventListeners, once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createMcpServer, createSessionCache, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, serveMcpStdio, sessionStamp } from "../src/mcp.js";
import { executeAgentOperation, getAgentToolDefinitions } from "../src/agent-protocol.js";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { queryProject } from "../src/search.js";
import { PACKAGE_VERSION } from "../src/spec.js";
import { sha256 } from "../src/util.js";
import { captureVerificationSnapshot, recordVerification } from "../src/verification.js";

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

for (const autoGenerate of [false, true]) {
  test(`invalid MCP operations never load a snapshot (autoGenerate=${autoGenerate})`, async () => {
    let loads = 0;
    const server = createMcpServer({ root: ".", autoGenerate, createSession: () => {
      loads += 1;
      throw new Error("Invalid input must not load a snapshot.");
    } });
    const cases = [
      ["llmnav_unknown", {}],
      ["llmnav_query", {}],
      ["llmnav_query", null],
      ["llmnav_query", { task: "fixture", top: 0 }],
      ["llmnav_query", { task: "fixture", unexpected: true }],
      ["llmnav_show", { id: "fixture.app", metadataBudget: 511 }],
    ];
    for (const [index, [name, args]] of cases.entries()) {
      const expected = await executeAgentOperation(".", name, args);
      assert.equal(expected.ok, false);
      const response = await server.handleMessage({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name, arguments: args } });
      assert.equal(response.result.isError, true);
      assert.deepEqual(JSON.parse(response.result.content[0].text), expected);
    }
    assert.equal(loads, 0);
    assert.equal(server.status().phase, "idle");
  });
}

test("invalid MCP input preserves generated artifacts after source edits", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-invalid-effects-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const cache = path.join(root, ".llmnav", "cache");
  const entries = await readdir(cache, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.relative(cache, path.join(entry.parentPath, entry.name))).sort();
  const paths = (await readdir(cache, { recursive: true })).sort();
  const before = await Promise.all(files.map(file => readFile(path.join(cache, file))));
  const source = path.join(root, "src", "rotate.ts");
  await writeFile(source, (await readFile(source, "utf8")).replace("Rotate one refresh-token family", "Rotate the changed refresh-token family"));
  const server = createMcpServer({ root, autoGenerate: true });
  const rejected = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "llmnav_query", arguments: {} } });
  assert.equal(JSON.parse(rejected.result.content[0].text).error.code, "LNVAP002");
  assert.deepEqual((await readdir(cache, { recursive: true })).sort(), paths);
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(cache, file)))), before);
  assert.equal(server.status().phase, "idle");
  await callTool(server, 2, "llmnav_query", { task: "changed refresh-token family" });
  assert.notDeepEqual(await readFile(path.join(cache, "manifest.json")), before[files.indexOf("manifest.json")]);
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
    assert.deepEqual(Object.keys(tool), ["name", "description", "inputSchema", "annotations"]);
    assert.deepEqual(tool.inputSchema, expected[index].inputSchema);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  }

  const ping = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual(ping.result, {});
});

test("MCP annotations distinguish automatic cache writes from session-independent reads", async () => {
  const server = createMcpServer({ root: ".", autoGenerate: true });
  const listed = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, ["llmnav_discover", "llmnav_history", "llmnav_verification"].includes(tool.name));
    assert.equal(tool.annotations.destructiveHint, false);
  }
  // Transport-specific hints do not change the provider-neutral schema contract.
  assert.ok(getAgentToolDefinitions().every(tool => !Object.hasOwn(tool, "annotations")));
});

for (const autoGenerate of [false, true]) {
  test(`local evidence bypasses MCP snapshot loading (autoGenerate=${autoGenerate})`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-evidence-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "test.log"), "PASS\n");
    const git = (...args) => {
      const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=.no-hooks", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("add", "source.ts");
    git("commit", "-qm", "fixture");
    const head = git("rev-parse", "HEAD");
    const snapshot = await captureVerificationSnapshot(root, ["source.ts"], { completeInputs: true });
    const receipt = await recordVerification(root, { snapshot, command: ["fixture-check"], outcome: "passed", evidence: ["test.log"] });
    let loads = 0;
    const server = createMcpServer({ root, autoGenerate, createSession: () => {
      loads += 1;
      throw new Error("Navigation snapshot must not be loaded for local evidence.");
    } });

    const history = await callTool(server, 1, "llmnav_history", { file: "source.ts" });
    assert.equal(history.data.lastChange.commit, head);
    assert.deepEqual(history.data.dirty, { staged: false, unstaged: false, untracked: false });
    const verification = await callTool(server, 2, "llmnav_verification", { id: receipt.id });
    assert.equal(verification.data.outcome, "passed");
    assert.equal(verification.data.applicability, "matches");
    const missing = await callTool(server, 3, "llmnav_verification", { id: "0".repeat(64) });
    assert.equal(missing.data.status, "unknown");
    const invalid = await server.handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "llmnav_verification", arguments: { id: 123 } } });
    assert.equal(invalid.result.isError, true);
    assert.equal(JSON.parse(invalid.result.content[0].text).error.code, "LNVAP002");
    assert.equal(loads, 0);
    assert.equal(server.status().phase, "idle");
    assert.deepEqual(await readdir(path.join(root, ".llmnav")), ["local"]);
  });
}

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

test("stdio bounds input read-ahead during output backpressure and resumes in order", { timeout: 15000 }, async (context) => {
  const total = 2000, padding = "x".repeat(16 * 1024);
  let produced = 0;
  const input = Readable.from((function* () {
    for (let id = 0; id < total; id += 1) {
      produced += 1;
      yield `${JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: { padding } })}\n`;
    }
  })(), { highWaterMark: 1 });
  const output = new EventEmitter(), written = Promise.withResolvers();
  const controller = new AbortController(), responses = [];
  output.write = (text) => {
    responses.push(JSON.parse(text).id);
    written.resolve();
    return responses.length > 1;
  };
  const serving = serveMcpStdio({ root: os.tmpdir(), input, output, signal: controller.signal });
  const observed = serving.catch(() => {});
  context.after(async () => { controller.abort(); input.destroy(); await observed; });
  await written.promise;
  await new Promise(resolve => setImmediate(resolve));
  context.diagnostic(JSON.stringify({ producedWhileBlocked: produced, paddingBytes: produced * padding.length }));
  assert.ok(produced <= 32, `Read ahead ${produced} frames while output was blocked`);
  assert.deepEqual(responses, [0]);
  output.emit("drain");
  assert.equal(await serving, 0);
  assert.equal(produced, total);
  assert.deepEqual(responses, Array.from({ length: total }, (_, id) => id));
  for (const event of ["drain", "close", "error"]) assert.equal(output.listenerCount(event), 0, event);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
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

for (const phase of ["idle", "backpressure", "tool"]) {
  test(`input failures settle stdio during ${phase} and release owned listeners`, { timeout: 5000 }, async (context) => {
    const input = new PassThrough(), output = new EventEmitter();
    const controller = new AbortController(), ready = Promise.withResolvers();
    let requestSignal, settled = false, failure;
    output.write = () => { ready.resolve(); return false; };
    const session = { query: (_task, options) => {
      requestSignal = options.signal;
      ready.resolve();
      return new Promise(() => {});
    } };
    const serving = serveMcpStdio({ root: os.tmpdir(), input, output, session,
      signal: controller.signal, requestTimeoutMs: 0 });
    const observed = serving.then(() => { settled = true; }, error => { settled = true; failure = error; });
    context.after(async () => { controller.abort(); input.destroy(); await observed; });
    if (phase === "backpressure") input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    else if (phase === "tool") input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "llmnav_query", arguments: { task: "fixture" } } }) + "\n");
    else ready.resolve();
    await ready.promise;
    const reason = Object.assign(new Error("input read failed"), { code: "EIO" });
    input.destroy(reason);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, "input failure must not wait for output drain or a request deadline");
    assert.equal(failure, reason);
    for (const event of ["drain", "close", "error"]) assert.equal(output.listenerCount(event), 0, event);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    if (phase === "tool") {
      assert.equal(requestSignal.aborted, true);
      assert.equal(requestSignal.reason, reason);
    }
  });
}

test("stdio rejects an already-failed input instead of waiting for another error event", { timeout: 5000 }, async (context) => {
  const input = new PassThrough(), output = new EventEmitter(), controller = new AbortController();
  const reason = Object.assign(new Error("input already failed"), { code: "EIO" });
  const onError = () => {};
  input.on("error", onError);
  await new Promise(resolve => { input.once("close", resolve); input.destroy(reason); });
  let settled = false, failure;
  output.write = () => true;
  const observed = serveMcpStdio({ root: os.tmpdir(), input, output, signal: controller.signal })
    .then(() => { settled = true; }, error => { settled = true; failure = error; });
  context.after(async () => { controller.abort(); await observed; input.removeListener("error", onError); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true);
  assert.equal(failure, reason);
  assert.equal(input.listenerCount("error"), 1, "caller-owned listener must survive cleanup");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  for (const event of ["drain", "close", "error"]) assert.equal(output.listenerCount(event), 0, event);
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
    ["manifest.json", { mtimeNs: 1_000_000n, ctimeNs: 1_000_000n, size: 10n, ino: 7n }],
    ["index.json", { mtimeNs: 1_000_000n, ctimeNs: 1_000_000n, size: 20n, ino: 7n }],
    ["search-index.json", { mtimeNs: 1_000_000n, ctimeNs: 1_000_000n, size: 30n, ino: 7n }],
    ["graph.json", null],
  ]);
  const readStamp = () => sessionStamp(root, async (filePath) => files.get(filePathFor(filePath)) ?? null);

  const baseStamp = await readStamp();
  assert.equal(
    baseStamp,
    "cache=.llmnav/cache|manifest.json:1000000:1000000:10:7|index.json:1000000:1000000:20:7|search-index.json:1000000:1000000:30:7|graph.json:missing|config.json:missing|lexicon.json:missing|ids.jsonl:missing",
  );
  assert.equal(await readStamp(), baseStamp);

  files.set("search-index.json", { mtimeNs: 1_000_001n, ctimeNs: 1_000_000n, size: 30n, ino: 7n });
  assert.notEqual(await readStamp(), baseStamp);
  files.set("search-index.json", { mtimeNs: 1_000_000n, ctimeNs: 1_000_000n, size: 30n, ino: 8n });
  assert.notEqual(await readStamp(), baseStamp);

  // Registering active IDs rewrites the registry without touching the cache.
  files.set("ids.jsonl", { mtimeNs: 1_000_000n, ctimeNs: 1_000_000n, size: 40n, ino: 7n });
  assert.match(await readStamp(), /\|ids\.jsonl:1000000:1000000:40:7$/u);
  const beforeLexicon = await readStamp();
  files.set("lexicon.json", { mtimeNs: 2_000_000n, ctimeNs: 1_000_000n, size: 40n, ino: 7n });
  assert.notEqual(await readStamp(), beforeLexicon);
});

test("change-time-only edits refresh each stamped input once without extra stats", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-ctime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const names = ["manifest.json", "index.json", "search-index.json", "graph.json", "config.json", "lexicon.json", "ids.jsonl"];
  const files = new Map(names.map(name => [name, { mtimeNs: 1n, ctimeNs: 1000n, size: 10n, ino: 7n }]));
  let stats = 0, refreshes = 0, creates = 0;
  const session = { refresh: async () => { refreshes++; } };
  const cache = createSessionCache(root, {
    sessionStamp: () => sessionStamp(root, async file => { stats++; return files.get(path.basename(file)); }),
    createSession: async () => { creates++; return session; },
  });
  assert.equal(await cache.current(), session);
  let expectedRefreshes = 0;
  for (const name of names) {
    for (const ctimeNs of [999n, 1001n]) {
      files.set(name, { ...files.get(name), ctimeNs });
      const before = stats;
      assert.equal(await cache.current(), session);
      assert.equal(stats - before, names.length);
      assert.equal(refreshes, ++expectedRefreshes, name);
      await cache.current();
      assert.equal(refreshes, expectedRefreshes, `${name}: unchanged stamps reuse the session`);
    }
  }
  assert.equal(creates, 1);
});

test("MCP reloads same-size aliases rewritten in place with restored modification time", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-restored-mtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const file = path.join(root, ".llmnav", "lexicon.json");
  const timestamp = new Date("2020-01-01T00:00:00Z");
  const lexicon = token => JSON.stringify({ version: 1, aliases: { [token]: "auth.session.rotate" } });
  await writeFile(file, lexicon("oldtoken"));
  await utimes(file, timestamp, timestamp);
  const before = await stat(file, { bigint: true });
  const server = createMcpServer({ root });
  assert.equal((await callTool(server, 1, "llmnav_query", { task: "oldtoken" })).data[0].id, "auth.session.rotate");
  await writeFile(file, lexicon("newtoken"));
  await utimes(file, timestamp, timestamp);
  const after = await stat(file, { bigint: true });
  for (const key of ["mtimeNs", "size", "ino"]) assert.equal(after[key], before[key], key);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  const result = (await callTool(server, 2, "llmnav_query", { task: "newtoken" })).data;
  assert.equal(result[0].id, "auth.session.rotate");
  assert.deepEqual(result, await queryProject(root, "newtoken"));
  assert.deepEqual((await callTool(server, 3, "llmnav_query", { task: "oldtoken" })).data, []);
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

test("opt-in MCP generation follows source edits, renames, deletion and recovery", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-auto-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const server = createMcpServer({ root, autoGenerate: true });
  const originalPath = path.join(root, "src", "rotate.ts");
  const source = await readFile(originalPath, "utf8");
  await callTool(server, 1, "llmnav_query", { task: "refresh token" });
  const manifestPath = path.join(root, ".llmnav/cache/manifest.json");
  const unchanged = await readFile(manifestPath, "utf8");
  await callTool(server, 2, "llmnav_query", { task: "refresh token" });
  assert.equal(await readFile(manifestPath, "utf8"), unchanged);
  await writeFile(originalPath, source.replace("Rotate one", "Rotate qzxupdated one"));
  const updated = await Promise.all([3, 4].map(id => callTool(server, id, "llmnav_query", { task: "qzxupdated" })));
  for (const result of updated) assert.equal(result.data[0].id, "auth.session.rotate");
  const renamed = path.join(root, "src", "moved.mts");
  await rename(originalPath, renamed);
  assert.equal((await callTool(server, 5, "llmnav_query", { task: "qzxupdated" })).data[0].location.path, "src/moved.mts");
  const validManifest = await readFile(manifestPath, "utf8");
  await writeFile(renamed, source.replace("id=auth.session.rotate", "id=INVALID"));
  const failed = await server.handleMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "llmnav_query", arguments: { task: "qzxupdated" } } });
  assert.equal(failed.error.data.code, "LLMNAV_REFRESH_FAILED");
  assert.equal(server.status().phase, "error");
  assert.equal(await readFile(manifestPath, "utf8"), validManifest);
  await writeFile(renamed, source);
  assert.equal((await callTool(server, 7, "llmnav_query", { task: "refresh token" })).data[0].id, "auth.session.rotate");
  assert.equal(server.status().phase, "ready");
  await rm(renamed);
  assert.deepEqual((await callTool(server, 8, "llmnav_query", { task: "refresh token" })).data, []);
});

for (const autoGenerate of [false, true]) {
  test(`MCP recovers deleted cache inputs on the next request only with auto-generation (autoGenerate=${autoGenerate})`, async context => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-cache-recovery-"));
    context.after(async () => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("llmnav-mcp-cache-recovery-"));
      await rm(root, { recursive: true, force: true });
    });
    await createProject(root);
    const server = createMcpServer({ root, autoGenerate });
    const original = await callTool(server, 1, "llmnav_query", { task: "refresh token" });
    const source = path.join(root, "src/rotate.ts"), before = await readFile(source);
    const indexPath = path.join(root, ".llmnav/cache/index.json");
    await rm(indexPath);
    const request = id => server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "llmnav_query", arguments: { task: "refresh token" } } });
    const failed = await request(2);
    assert.match(failed.error.message, /No generated index found/u);
    assert.equal(server.status().phase, "error");
    const retried = await request(3);
    if (autoGenerate) {
      assert.equal(retried.error, undefined, retried.error?.message);
      assert.deepEqual(JSON.parse(retried.result.content[0].text), original);
      assert.equal(server.status().phase, "ready");
      assert.ok((await stat(indexPath)).isFile());
    } else {
      assert.match(retried.error.message, /No generated index found/u);
      await assert.rejects(readFile(indexPath), { code: "ENOENT" });
    }
    assert.deepEqual(await readFile(source), before);
  });
}

test("MCP auto-generation rejects stale compiler configuration dependencies and recovers", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-mcp-compiler-inputs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const configPath = path.join(root, ".llmnav/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.sourceRoots = ["src"];
  config.graph = { indexFiles: [".llmnav/imports/compiler.json"] };
  await writeFile(configPath, JSON.stringify(config));
  const metadataPath = path.join(root, "tsconfig.base.json");
  const initial = '{"compilerOptions":{"target":"ES2022"}}\n';
  const changed = initial.replace("ES2022", "ES2023");
  await writeFile(metadataPath, initial);
  await mkdir(path.join(root, ".llmnav/imports"), { recursive: true });
  const graphPath = path.join(root, ".llmnav/imports/compiler.json");
  const graph = { schemaVersion: 2, repositoryId: config.repositoryId, generator: "llmnav-typescript@1;typescript@6.0.3",
    sourceHashes: { "src/rotate.ts": sha256(await readFile(path.join(root, "src/rotate.ts"))), "tsconfig.base.json": sha256(initial) },
    definitions: [{ id: "auth.session.rotate", symbol: "rotateSession", path: "src/rotate.ts", line: 7, kind: "FunctionDeclaration" }], references: [] };
  await writeFile(graphPath, JSON.stringify(graph));
  const server = createMcpServer({ root, autoGenerate: true });
  await callTool(server, 1, "llmnav_query", { task: "refresh token" });
  const manifestPath = path.join(root, ".llmnav/cache/manifest.json");
  const saved = await readFile(manifestPath, "utf8");
  await writeFile(metadataPath, changed);
  const request = id => server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "llmnav_query", arguments: { task: "refresh token" } } });
  const stale = await request(2);
  context.diagnostic(JSON.stringify({ acceptedStaleResponse: stale.result !== undefined, error: stale.error?.data?.code ?? null }));
  assert.equal(stale.error?.data?.code, "LLMNAV_REFRESH_FAILED");
  assert.equal(server.status().phase, "error");
  assert.equal(await readFile(manifestPath, "utf8"), saved);
  graph.sourceHashes["tsconfig.base.json"] = sha256(changed);
  await writeFile(graphPath, JSON.stringify(graph));
  await callTool(server, 3, "llmnav_query", { task: "refresh token" });
  await rm(metadataPath);
  assert.equal((await request(4)).error?.data?.code, "LLMNAV_REFRESH_FAILED");
  await writeFile(metadataPath, changed);
  await callTool(server, 5, "llmnav_query", { task: "refresh token" });
  assert.equal(server.status().phase, "ready");
  for (const invalid of ["{", JSON.stringify({ ...graph, sourceHashes: { "../outside.json": sha256(changed) } })]) {
    await writeFile(graphPath, invalid);
    assert.equal((await request(6)).error?.data?.code, "LLMNAV_REFRESH_FAILED");
  }
  await writeFile(graphPath, JSON.stringify(graph));
  await callTool(server, 7, "llmnav_query", { task: "refresh token" });
});
