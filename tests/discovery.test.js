import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverProject } from "../src/discovery.js";
import { executeAgentOperation } from "../src/agent-protocol.js";
import { createMcpServer } from "../src/mcp.js";

const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-discovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), '{"name":"discovery-fixture"}\n');
  await writeFile(path.join(root, "src/session.mts"), [
    "// function ghostComment() {}",
    'const documentation = `',
    'function ghostTemplate() {}',
    '`;',
    '/*',
    'function ghostBlock() {}',
    '*/',
    'export function rotateSession(token: string): string { return token; }',
    'export function revokeSession(): void {}',
    '',
  ].join("\n"));
  await writeFile(path.join(root, "src/session.go"), 'package session\nfunc (s *Session) RotateSession(token string) string { return token }\n');
  return root;
}

test("discovers live declarations and paths before init without writing cache or cards", async context => {
  const root = await fixture(context);
  const before = await readFile(path.join(root, "src/session.mts"), "utf8");
  const result = await discoverProject(root, "rotate session", { top: 10 });
  assert.equal(result.schemaVersion, 1);
  const symbols = result.results.filter(item => item.source === "declaration");
  assert.ok(symbols.some(item => item.symbol === "rotateSession" && item.path === "src/session.mts" && item.line === 8));
  assert.ok(symbols.some(item => item.symbol === "RotateSession" && item.language === "go"));
  assert.ok(result.results.some(item => item.source === "file" && item.path === "src/session.mts"));
  assert.ok(result.results.every(item => item.cardIds.length === 0 && !Object.hasOwn(item, "id") && !Object.hasOwn(item, "invariant")));
  await writeFile(path.join(root, "src/boundary.ts"), "const unrelated = 1;\nexport function boundaryUnique() {}\n");
  const boundary = await discoverProject(root, "boundaryUnique", { top: 100 });
  assert.deepEqual(boundary.results.map(item => item.symbol), ["boundaryUnique"]);
  const ghosts = await discoverProject(root, "ghost", { top: 100 });
  assert.equal(ghosts.results.some(item => item.symbol?.startsWith("ghost")), false);
  assert.deepEqual(await discoverProject(root, "rotate session", { top: 10, ioConcurrency: 1 }), result);
  const bounded = await discoverProject(root, "rotate session", { top: 1 });
  assert.equal(bounded.results.length, 1);
  assert.equal(bounded.truncated, true);
  await assert.rejects(readFile(path.join(root, ".llmnav/cache/index.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "src/session.mts"), "utf8"), before);
  await writeFile(path.join(root, "src/session.mts"), 'export function editedSymbol() {}\n');
  assert.equal((await discoverProject(root, "editedSymbol")).results[0].symbol, "editedSymbol");
  for (const top of [0, 101, 1.5]) await assert.rejects(discoverProject(root, "session", { top }), RangeError);
  await assert.rejects(discoverProject(root, "  "), TypeError);
  const controller = new AbortController();
  const reason = new Error("stop discovery");
  controller.abort(reason);
  await assert.rejects(discoverProject(root, "session", { signal: controller.signal }), error => error === reason);
});

test("CLI, agent protocol and MCP expose the same unindexed discovery results", async context => {
  const root = await fixture(context);
  const expected = await discoverProject(root, "rotateSession", { top: 2 });
  const process = spawnSync(globalThis.process.execPath, [cli, "discover", "rotateSession", "--root", root, "--top", "2", "--json"], { encoding: "utf8" });
  assert.equal(process.status, 0, process.stderr);
  assert.deepEqual(JSON.parse(process.stdout), expected);
  const operation = await executeAgentOperation(root, "llmnav_discover", { task: "rotateSession", top: 2 });
  assert.equal(operation.ok, true);
  assert.deepEqual(operation.data, expected);
  const server = createMcpServer({ root, autoGenerate: true, createSession: () => { throw new Error("Discovery must not load an index"); } });
  const reply = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "llmnav_discover", arguments: { task: "rotateSession", top: 2 } } });
  assert.deepEqual(JSON.parse(reply.result.content[0].text).data, expected);
  await assert.rejects(readFile(path.join(root, ".llmnav/config.json")), { code: "ENOENT" });
});

test("source provenance links existing same-file cards without inventing semantic IDs", async context => {
  const root = await fixture(context);
  await writeFile(path.join(root, "src/card.cts"), '/* llmnav/1 symbol\nid=fixture.card.load\nrole=Load reviewed data.\nsearch=reviewed load|load data\nstability=contract\n*/\nexport function loadReviewedData() {}\n');
  const result = await discoverProject(root, "loadReviewedData");
  assert.equal(result.results[0].source, "declaration");
  assert.deepEqual(result.results[0].cardIds, ["fixture.card.load"]);
  assert.equal(result.results[0].language, "typescript");
  assert.equal(Object.hasOwn(result.results[0], "role"), false);
});
