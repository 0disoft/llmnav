import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMcpServer, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME } from "../src/mcp.js";
import { getAgentToolDefinitions } from "../src/agent-protocol.js";
import { initializeProject } from "../src/initializer.js";
import { PACKAGE_VERSION } from "../src/spec.js";

const CLI = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));

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
