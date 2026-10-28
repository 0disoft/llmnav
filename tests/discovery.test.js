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

test("bounded discovery preserves full ranking, late winners, match counts and selected excerpts", async context => {
  const root = await fixture(context);
  const ordinary = Array.from({ length: 20 }, (_, i) => `export function operation${i}() {}\n`).join("");
  await writeFile(path.join(root, "src/needle-a.ts"), ordinary);
  await writeFile(path.join(root, "src/needle-b.ts"), ordinary);
  await writeFile(path.join(root, "src/z.ts"), "export function needle() {}\nexport function needleLater() {}\n");
  const complete = await discoverProject(root, "needle", { top: 100 });
  assert.equal(complete.matched, 44);
  assert.equal(complete.truncated, false);
  assert.equal(complete.results[0].symbol, "needle");
  for (const top of [1, 2, 3, 5]) {
    const bounded = await discoverProject(root, "needle", { top, includeSource: true, sourceBudget: 4000 });
    assert.equal(bounded.matched, complete.matched);
    assert.equal(bounded.truncated, true);
    assert.deepEqual(bounded.results.map(({ sourceExcerpt, ...candidate }) => candidate), complete.results.slice(0, top));
    assert.equal(bounded.results[0].sourceExcerpt.text, "export function needle() {}");
    assert.equal(bounded.results[0].sourceExcerpt.startLine, 1);
  }
});

test("long discovery queries index absent terms once and preserve ranking and reason order", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-discovery-terms-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "work.ts"), Array.from({ length: 100 }, (_, i) =>
    `export function workAlpha${i}(value: number): number { return value; }\n`).join(""));
  const absent = Array.from({ length: 2000 }, (_, i) => `absentqueryterm${i}`);
  const options = { top: 3, includeSource: true, sourceBudget: 256 };
  for (const terms of ["number work", "work number work"]) {
    const expected = await discoverProject(root, terms, options);
    const originalSetHas = Set.prototype.has, originalMapHas = Map.prototype.has;
    let absentProbes = 0, indexedProbes = 0;
    const setMock = context.mock.method(Set.prototype, "has", function (key) {
      if (typeof key === "string" && key.startsWith("absentqueryterm")) absentProbes++;
      return originalSetHas.call(this, key);
    });
    const mapMock = context.mock.method(Map.prototype, "has", function (key) {
      if (this.get(absent[0]) === 0) indexedProbes++;
      return originalMapHas.call(this, key);
    });
    let actual;
    try { actual = await discoverProject(root, [...absent, terms].join(" "), options); }
    finally { setMock.mock.restore(); mapMock.mock.restore(); }
    context.diagnostic(JSON.stringify({ candidates: 101, absentTerms: absent.length, absentProbes, indexedProbes }));
    assert.deepEqual(actual, expected);
    assert.ok(absentProbes <= absent.length * 3, `absent term probes: ${absentProbes}`);
    assert.ok(indexedProbes < 4000, `candidate token probes: ${indexedProbes}`);
  }
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

test("opt-in source excerpts reuse the ranked live declaration and preserve default results", async context => {
  const root = await fixture(context);
  await rm(path.join(root, "src/session.go"));
  const plain = await discoverProject(root, "rotateSession", { top: 1 });
  assert.equal(Object.hasOwn(plain.results[0], "sourceExcerpt"), false);
  const options = { top: 1, includeSource: true, sourceBudget: 256 };
  const result = await discoverProject(root, "rotateSession", options);
  const { sourceExcerpt, ...candidate } = result.results[0];
  assert.deepEqual(candidate, plain.results[0]);
  assert.deepEqual(sourceExcerpt, { scope: "declaration", startLine: 8, endLine: 8,
    text: "export function rotateSession(token: string): string { return token; }", truncated: false });
  const server = createMcpServer({ root });
  const reply = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "llmnav_discover", arguments: { task: "rotateSession", ...options } } });
  assert.deepEqual(JSON.parse(reply.result.content[0].text).data, result);
  const process = spawnSync(globalThis.process.execPath, [cli, "discover", "rotateSession", "--root", root,
    "--top", "1", "--include-source", "--source-budget", "256", "--json"], { encoding: "utf8" });
  assert.equal(process.status, 0, process.stderr);
  assert.deepEqual(JSON.parse(process.stdout), result);
});

test("source budget is shared, UTF-8 safe, newline normalized, and explicit about truncation", async context => {
  const root = await fixture(context);
  const source = `export function budgetFirst() {\r\n  return "${"한😀".repeat(100)}";\r\n}\r\nexport function budgetSecond() {}\r\n`;
  await writeFile(path.join(root, "src/budget.ts"), source);
  const result = await discoverProject(root, "budget", { top: 10, includeSource: true, sourceBudget: 256 });
  const excerpts = result.results.flatMap(item => item.sourceExcerpt ? [item.sourceExcerpt] : []);
  assert.ok(excerpts.length > 0);
  assert.ok(excerpts.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) <= 256);
  assert.equal(excerpts[0].truncated, true);
  assert.ok(excerpts.every(item => !item.text.includes("\r") && !item.text.includes("\uFFFD")));
  assert.ok(excerpts.every(item => item.endLine >= item.startLine));
  assert.ok(excerpts.every(item => Buffer.from(item.text).toString("utf8") === item.text));
  for (const sourceBudget of [255, 16001, 1.5, NaN]) {
    await assert.rejects(discoverProject(root, "budget", { includeSource: true, sourceBudget }), RangeError);
  }
  await assert.rejects(discoverProject(root, "budget", { includeSource: "true" }), TypeError);
});
