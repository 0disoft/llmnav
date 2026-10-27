import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeAgentOperation } from "../src/agent-protocol.js";
import { initializeProject } from "../src/initializer.js";
import { createProjectSession } from "../src/search.js";
import { createMcpServer } from "../src/mcp.js";
import { sha256 } from "../src/util.js";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-query-source-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), '{"name":"query-source"}\n');
  await writeFile(path.join(root, "src/policy.js"), "/* llmnav/1 module\nid=fixture.policy\nrole=Enforce budget limits.\nstability=contract\n*/\nexport const limitValue = 256;\n");
  await writeFile(path.join(root, "src/consumer.js"), 'export function applyLimit(value) {\r\n  return value < limitValue ? "가😀" : value;\r\n}\r\n');
  assert.equal((await initializeProject(root, { agents: ["none"] })).ok, true);
  return root;
}

test("query source mode combines live cross-file windows and compact cards without changing default results", async context => {
  const root = await fixture(context);
  const plain = await executeAgentOperation(root, "llmnav_query", { task: "budget" });
  const session = await createProjectSession(root);
  const input = { task: "budget", includeSource: true, sourceTerms: ["limitValue"], sourceBudget: 4000 };
  const result = await executeAgentOperation(root, "llmnav_query", input);
  assert.equal(result.ok, true);
  assert.deepEqual((await executeAgentOperation(root, "llmnav_query", input, { session })).data, result.data);
  const server = createMcpServer({ root, session });
  const reply = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "llmnav_query", arguments: input } });
  assert.deepEqual(JSON.parse(reply.result.content[0].text).data, result.data);
  assert.deepEqual(result.data.cards.map(item => item.id), plain.data.map(item => item.id));
  assert.equal(Object.hasOwn(result.data.cards[0], "card"), false);
  assert.deepEqual(result.data.excerpts.map(item => item.path), ["src/consumer.js", "src/policy.js"]);
  for (const excerpt of result.data.excerpts) {
    const raw = await readFile(path.join(root, excerpt.path), "utf8");
    assert.equal(excerpt.sourceHash, sha256(raw));
    assert.equal(excerpt.text.includes("\r"), false);
    assert.ok(excerpt.text.includes("limitValue"));
  }
  assert.deepEqual(await executeAgentOperation(root, "llmnav_query", { task: "budget" }), plain);
  // The same prepared card snapshot must still return current source evidence.
  await writeFile(path.join(root, "src/consumer.js"), "export const limitValue = 999;\n");
  const edited = await executeAgentOperation(root, "llmnav_query", input, { session });
  assert.ok(edited.data.excerpts.find(item => item.path === "src/consumer.js").text.includes("999"));
});

test("query source budgets bound UTF-8 across files and report missing or clipped matches", async context => {
  const root = await fixture(context);
  await writeFile(path.join(root, "src/large.js"), `export const limitValue = "${"가😀".repeat(3000)}";\n`);
  for (const sourceBudget of [256, 257, 4000, 16000]) {
    const result = await executeAgentOperation(root, "llmnav_query", { task: "budget", includeSource: true, sourceTerms: ["limitValue"], sourceBudget });
    assert.equal(result.ok, true);
    const bytes = result.data.excerpts.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
    assert.equal(bytes, result.data.sourceBytes);
    assert.ok(bytes <= sourceBudget);
    assert.ok(result.data.excerpts.every(item => !item.text.includes("\ufffd")));
    assert.equal(result.data.truncated, true);
  }
  const missing = await executeAgentOperation(root, "llmnav_query", { task: "budget", includeSource: true, sourceTerms: ["noSuchLiteral"] });
  assert.deepEqual(missing.data.excerpts, []);
  assert.equal(missing.data.sourceBytes, 0);
  assert.equal(missing.data.matchedFiles, 0);
});

test("query source validation rejects invalid work before session or filesystem access", async () => {
  let calls = 0;
  const session = { query() { calls++; throw new Error("Must not query"); } };
  for (const input of [
    { includeSource: true }, { sourceTerms: ["needle"] }, { includeSource: true, sourceTerms: [] },
    { includeSource: true, sourceTerms: Array(9).fill("x") }, { includeSource: true, sourceTerms: [" "] },
    { includeSource: true, sourceTerms: ["x".repeat(129)] }, { includeSource: true, sourceTerms: ["a\nb"] },
    ...[255, 16001, 256.5].map(sourceBudget => ({ includeSource: true, sourceTerms: ["x"], sourceBudget })),
  ]) {
    const result = await executeAgentOperation("missing-repository", "llmnav_query", { task: "budget", ...input }, { session });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "LNVAP002");
  }
  assert.equal(calls, 0);
});

test("query source omits matching test fixtures when runtime matches exist and reports the scope", async context => {
  const root = await fixture(context);
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "tests/example.test.js"), "export const limitValue = 42;\n");
  const result = await executeAgentOperation(root, "llmnav_query", { task: "budget", includeSource: true, sourceTerms: ["limitValue"] });
  assert.equal(result.data.matchedFiles, 3);
  assert.equal(result.data.omittedNonProductionFiles, 1);
  assert.ok(result.data.excerpts.every(item => item.path.startsWith("src/")));
  const aborted = await executeAgentOperation(root, "llmnav_query", { task: "budget", includeSource: true, sourceTerms: ["limitValue"] }, { signal: AbortSignal.abort() });
  assert.equal(aborted.ok, false);
});

test("query source merges touching windows, ranks late multi-term matches and bounds retained files", async context => {
  const root = await fixture(context);
  const lines = Array(60).fill("// padding");
  lines[10] = "const needleA = 1;";
  lines[27] = "use(needleA);";
  lines[45] = "use(needleA, needleB);";
  await writeFile(path.join(root, "src/windows.js"), lines.join("\n"));
  const input = { task: "budget", includeSource: true, sourceTerms: ["needleA", "needleB"], sourceBudget: 16000 };
  const result = (await executeAgentOperation(root, "llmnav_query", input)).data;
  assert.deepEqual(result.excerpts.map(item => [item.startLine, item.endLine]), [[38, 54], [3, 36]]);
  assert.equal(result.truncated, false);
  for (let i = 0; i < 14; i++) await writeFile(path.join(root, `src/extra${String(i).padStart(2, "0")}.js`), "use(needleA);\n");
  const many = (await executeAgentOperation(root, "llmnav_query", input)).data;
  assert.equal(many.matchedFiles, 15);
  assert.equal(many.omittedFiles, 3);
  assert.ok(many.excerpts.some(item => item.path === "src/windows.js"), "a late two-term file must outrank one-term files");
  assert.ok(new Set(many.excerpts.map(item => item.path)).size <= 12);
  const literal = (await executeAgentOperation(root, "llmnav_query", { ...input, sourceTerms: ["needle.*"] })).data;
  assert.deepEqual(literal.excerpts, []);
});
