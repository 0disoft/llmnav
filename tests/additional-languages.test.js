import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";
import { discoverProject } from "../src/discovery.js";
import { loadConfig } from "../src/config.js";
import { loadGraphInputs, normalizeGraphInput } from "../src/graph-input.js";

async function fixture(context, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-languages-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "languages", graph: { indexFiles: [".llmnav/imports/code.json"] } }));
  for (const [name, source] of Object.entries(files)) await writeFile(path.join(root, name), source);
  return root;
}
const find = (result, name) => result.graph.definitions.find(item => item.symbol === name);
function withoutMetadata(graph) { return { ...graph, schemaVersion: 2, definitions: graph.definitions.map(({ metadata, ...row }) => row) }; }

test("JavaScript reuses compiler bindings, JSDoc types and explicit unknown types", async context => {
  const source = "/** @param {string} label */\nexport function save(label) { return label.length; }\n" +
    "export class Store { count = 1; run(value) { return save(value); } }\n" +
    "const quoted = 'function fake() {}'; // function comment() {}\n";
  const root = await fixture(context, { "main.mjs": source });
  const result = await analyzeProject(root, { language: "javascript", metadata: true });
  assert.deepEqual(withoutMetadata(result.graph), (await analyzeProject(root, { language: "javascript" })).graph);
  assert.equal(find(result, "save").metadata.parameters[0].type, "string");
  assert.equal(find(result, "save").metadata.parameters[0].typeOrigin, "declared");
  assert.equal(find(result, "Store.run").metadata.owner, find(result, "Store").id);
  assert.equal(find(result, "Store.run").metadata.parameters[0].type, null);
  assert.equal(find(result, "value").metadata.typeOrigin, "unknown");
  assert.equal(find(result, "count").metadata.typeOrigin, "inferred");
  assert.ok(result.graph.references.some(edge => edge.kind === "calls" && edge.to === find(result, "save").id));
  assert.equal(find(result, "fake"), undefined);
  normalizeGraphInput(result.graph);
  await writeFile(path.join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, files: ["main.mjs"] }));
  await assert.rejects(analyzeProject(root, { language: "javascript", project: "jsconfig.json" }), /7006/u);
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
  const { config } = await loadConfig(root);
  await writeFile(path.join(root, "new.cjs"), "exports.newName = 1;\n");
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /source set changed/u);
  await rm(path.join(root, "new.cjs"));
  await writeFile(path.join(root, "main.mjs"), source + "export const changed = 2;\n");
  await assert.rejects(writeAnalysis(root, ".llmnav/imports/code.json", result), /Stale compiler analysis/u);
  const bad = await fixture(context, { "bad.js": "export function broken( {\n" });
  await assert.rejects(analyzeProject(bad, { language: "javascript" }), /1005|1136|Error/u);
});

test("Python AST preserves explicit annotations, Unicode locations and unknowns without executing source", {
  skip: spawnSync("python", ["--version"], { windowsHide: true }).status !== 0,
}, async context => {
  const source = "raise RuntimeError('never execute')\n" +
    "class Store:\n    count: int = 1\n    async def save(self, label: str, count=1, /, *, flag: bool=False, **extra) -> str:\n        return label\n" +
    "가 = 1; 크기: int = 2\ntext = 'def fake(): pass'\n# def comment(): pass\n";
  const root = await fixture(context, { "main.py": source, "empty.py": "" });
  const result = await analyzeProject(root, { language: "python", metadata: true });
  assert.equal(result.precision, "syntax");
  const method = find(result, "Store.save");
  assert.equal(method.metadata.owner, find(result, "Store").id);
  assert.equal(method.line, 4);
  assert.equal(method.metadata.type, "str");
  assert.equal(method.metadata.parameters.find(item => item.name === "count").type, null);
  assert.equal(method.metadata.parameters.find(item => item.name === "extra").variadic, true);
  assert.equal(find(result, "count").metadata.category, "field");
  assert.equal(find(result, "크기").metadata.type, "int");
  assert.equal(find(result, "fake"), undefined);
  assert.equal(result.graph.references.some(edge => edge.kind === "calls"), false);
  assert.deepEqual(withoutMetadata(result.graph), (await analyzeProject(root, { language: "python" })).graph);
  normalizeGraphInput(result.graph);
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
  const candidate = (await discoverProject(root, "Store.save", { precise: true })).results.find(item => item.id === `languages/${method.id}`);
  assert.equal(candidate.precision, "syntax");
  assert.equal(candidate.source, "declaration");
  assert.equal(candidate.compiler, undefined);
  await writeFile(path.join(root, "bad.py"), "def broken(:\n");
  await assert.rejects(analyzeProject(root, { language: "python" }), /PY_SYNTAX/u);
  const partial = await analyzeProject(root, { language: "python", metadata: true, allowErrors: true });
  assert.equal(partial.diagnostics.length, 1);
  assert.ok(find(partial, "Store"));
  assert.equal(find(partial, "broken"), undefined);
  await assert.rejects(analyzeProject(root, { language: "python", pythonCommand: "llmnav-missing-python" }), /ENOENT/u);
});

test("Rust lexical metadata masks nested comments, literals and macros and limits impl ownership", async context => {
  const source = "/* outer /* inner */ fn fake() {} */\n" +
    'const TEXT: &str = r###"fn raw_fake() {}"###;\n' +
    "macro_rules! make { () => { fn macro_fake() {} } }\n" +
    "pub struct Store { pub count: i32, pairs: Vec<(i32, i32)> }\n" +
    "impl Store { pub fn save(&self, label: &str, pairs: Vec<(i32, i32)>) -> i32 { self.count } }\n" +
    "impl<T> Other<T> { fn unresolved(&self) {} }\n" +
    "pub trait Named { fn name(&self) -> &str; }\n" +
    "pub fn borrow<'a>(value: &'a str) -> &'a str { let c = '{'; value }\n";
  const root = await fixture(context, { "main.rs": source });
  const result = await analyzeProject(root, { language: "rust", metadata: true });
  assert.equal(result.precision, "syntax");
  assert.equal(find(result, "fake"), undefined);
  assert.equal(find(result, "raw_fake"), undefined);
  assert.equal(find(result, "macro_fake"), undefined);
  assert.equal(find(result, "Store.save").metadata.owner, find(result, "Store").id);
  assert.equal(find(result, "Store.save").metadata.parameters[2].type, "Vec<(i32, i32)>");
  assert.equal(find(result, "pairs").metadata.type, "Vec<(i32, i32)>");
  assert.equal(find(result, "unresolved").metadata.owner, null);
  assert.equal(find(result, "Named.name").metadata.owner, find(result, "Named").id);
  assert.equal(find(result, "borrow").metadata.parameters[0].type, "&'a str");
  assert.ok(result.graph.definitions.every(row => row.metadata.precision === "syntax" && row.metadata.status === "partial"));
  normalizeGraphInput(result.graph);
  const invalid = structuredClone(result.graph);
  invalid.definitions[0].metadata.precision = "verified";
  assert.throws(() => normalizeGraphInput(invalid), /precision/u);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/llmnav.js", import.meta.url)), "analyze", "--language", "rust", "--metadata", "--root", root, "--json"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).graph, result.graph);
  assert.deepEqual(withoutMetadata(result.graph), (await analyzeProject(root, { language: "rust" })).graph);
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
  const saved = await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8");
  await writeFile(path.join(root, "main.rs"), source + "}\n");
  await assert.rejects(analyzeProject(root, { language: "rust" }), /Unbalanced/u);
  assert.equal((await analyzeProject(root, { language: "rust", allowErrors: true })).diagnostics[0].code, "RS_SYNTAX");
  await assert.rejects(writeAnalysis(root, ".llmnav/imports/code.json", result), /Stale compiler analysis/u);
  assert.equal(await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8"), saved);
});
