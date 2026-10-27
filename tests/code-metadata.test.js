import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";
import { loadConfig } from "../src/config.js";
import { loadGraphInputs, normalizeGraphInput } from "../src/graph-input.js";

async function fixture(context, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-metadata-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "metadata", graph: { indexFiles: [".llmnav/imports/code.json"] } }));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  return root;
}
function legacy(graph) {
  return { ...graph, schemaVersion: 2, definitions: graph.definitions.map(({ metadata, ...definition }) => definition) };
}

test("TypeScript metadata preserves IDs and edges, overloads, type origins and ownership", async context => {
  const source = "export interface Config { label: string; run(value: number): boolean }\n" +
    "export class Store { value: number = 1; save(label: string, count = 1, ...flags: boolean[]): string { return label; } }\n" +
    "export function parse(value: string): string;\nexport function parse(value: number): number;\n" +
    "export function parse(value: string | number) { return value; }\n" +
    "export const size = 42;\nexport const double = (value: number) => value * 2;\n";
  const root = await fixture(context, { "main.ts": source });
  const before = await analyzeProject(root, { language: "typescript" });
  const result = await analyzeProject(root, { language: "typescript", metadata: true });
  assert.deepEqual(legacy(result.graph), before.graph);
  assert.equal(result.graph.schemaVersion, 3);
  const definitions = result.graph.definitions;
  const find = symbol => definitions.find(item => item.symbol === symbol);
  const method = find("Store.save").metadata;
  assert.equal(method.owner, find("Store").id);
  assert.equal(method.category, "method");
  assert.deepEqual(method.parameters.map(item => [item.name, item.typeOrigin, item.optional, item.variadic]), [
    ["label", "declared", false, false], ["count", "inferred", true, false], ["flags", "declared", false, true],
  ]);
  assert.equal(definitions.find(item => item.symbol === "value" && item.metadata.owner === find("Store").id).metadata.category, "field");
  assert.equal(find("size").metadata.typeOrigin, "inferred");
  assert.equal(find("double").metadata.category, "function");
  assert.equal(find("parse").metadata.signatures.length, 2);
  assert.equal(find("Config.run").metadata.owner, find("Config").id);
  assert.equal(find("Config.run").metadata.parameters[0].type, "number");
  assert.deepEqual((await analyzeProject(root, { language: "typescript", metadata: true })).graph, result.graph);
  const normalized = normalizeGraphInput(result.graph);
  assert.equal(normalized.definitions.find(item => item.symbol === "Store.save").metadata.owner, `metadata/${find("Store").id}`);
  assert.throws(() => normalizeGraphInput({ ...result.graph, schemaVersion: 2 }), /unknown property "metadata"/u);
  const invalid = structuredClone(result.graph);
  invalid.definitions[0].metadata.typeOrigin = "guessed";
  assert.throws(() => normalizeGraphInput(invalid), /origin/u);
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
  const { config } = await loadConfig(root);
  assert.equal((await loadGraphInputs(root, config)).diagnostics.length, 0);
  await writeFile(path.join(root, "main.ts"), source.replace("label: string", "label: number"));
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /Stale compiler analysis/u);
});

test("TypeScript erroneous types remain partial and unknown", async context => {
  const root = await fixture(context, { "main.ts": "export const missing: Missing = 1;\n" });
  await assert.rejects(analyzeProject(root, { language: "typescript", metadata: true }), /Missing/u);
  const result = await analyzeProject(root, { language: "typescript", metadata: true, allowErrors: true });
  const metadata = result.graph.definitions.find(item => item.symbol === "missing").metadata;
  assert.equal(metadata.status, "partial");
  assert.equal(metadata.type, null);
  assert.equal(metadata.typeOrigin, "unknown");
});

test("Go metadata resolves receiver owners, fields, generic and variadic parameters", {
  skip: spawnSync("go", ["version"], { windowsHide: true }).status !== 0, timeout: 120000,
}, async context => {
  const root = await fixture(context, {
    "go.mod": "module test.local/metadata\n\ngo 1.22\n",
    "main.go": "package metadata\ntype Store struct { Value int }\n" +
      "func (s *Store) Save(label string, flags ...bool) int { return s.Value }\n" +
      "func Identity[T any](value T) T { return value }\nvar Size = 42\n",
  });
  const before = await analyzeProject(root, { language: "go" });
  const result = await analyzeProject(root, { language: "go", metadata: true });
  assert.deepEqual(legacy(result.graph), before.graph);
  const find = symbol => result.graph.definitions.find(item => item.symbol === symbol);
  const method = find("Store.Save").metadata;
  assert.equal(method.category, "method");
  assert.equal(method.owner, find("Store").id);
  assert.equal(find("Value").metadata.category, "field");
  assert.equal(find("Value").metadata.owner, find("Store").id);
  assert.equal(find("Size").metadata.typeOrigin, "inferred");
  assert.deepEqual(method.parameters.map(item => [item.name, item.type, item.variadic]), [["label", "string", false], ["flags", "[]bool", true]]);
  assert.equal(find("Identity").metadata.parameters[0].type, "T");
  assert.match(find("Identity").metadata.signatures[0], /\[T any\]/u);
  normalizeGraphInput(result.graph);
});
