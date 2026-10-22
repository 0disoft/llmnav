import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";
import { discoverProject } from "../src/discovery.js";
import { generateProject } from "../src/generator.js";
import { showProjectCard, buildContext } from "../src/search.js";
import { loadConfig } from "../src/config.js";
import { loadGraphInputs, normalizeGraphInput } from "../src/graph-input.js";

async function fixture(context, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-compiler-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "compiler-fixture", graph: { indexFiles: [".llmnav/imports/code.json"] } }));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}
const card = "/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate a session token.\nsearch=rotate session|session token\nstability=contract\n*/\n";

test("TypeScript resolves renamed imports and shadowed symbols with fresh compiler provenance", async context => {
  const root = await fixture(context, {
    "lib.mts": `${card}export function rotate(token: string) { return token; }\nexport class One { run() { return rotate('one'); } }\nexport class Two { run() { return 'two'; } }\n`,
    "main.mts": "import { rotate as renamed, One, Two } from './lib.mjs';\nexport function invoke() { const result = renamed('ok'); return result; }\nexport function shadow() { const renamed = (x: string) => x; return renamed('local'); }\nexport function first() { return new One().run(); }\nexport function second() { return new Two().run(); }\n",
  });
  const result = await analyzeProject(root, { language: "typescript" });
  const defs = new Map(result.graph.definitions.map(item => [item.id, item]));
  assert.ok(defs.has("auth.session.rotate"));
  const caller = result.graph.definitions.find(item => item.symbol === "invoke");
  const shadow = result.graph.definitions.find(item => item.symbol === "shadow");
  assert.ok(result.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  assert.equal(result.graph.references.some(edge => edge.from === shadow.id && edge.to === "auth.session.rotate"), false);
  const methods = result.graph.definitions.filter(item => item.symbol.endsWith(".run")).sort((a, b) => a.line - b.line);
  assert.equal(methods.length, 2);
  assert.notEqual(methods[0].id, methods[1].id);
  for (const [name, methodIndex] of [["first", 0], ["second", 1]]) {
    const caller = result.graph.definitions.find(item => item.symbol === name);
    assert.ok(result.graph.references.some(edge => edge.from === caller.id && edge.to === methods[methodIndex].id && edge.kind === "calls"), JSON.stringify({ name, methods, references: result.graph.references, caller }));
  }
  assert.deepEqual((await analyzeProject(root, { language: "typescript" })).graph, result.graph);
  normalizeGraphInput(result.graph);
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
  const { config } = await loadConfig(root);
  assert.equal((await loadGraphInputs(root, config)).diagnostics.length, 0);
  assert.equal((await generateProject(root)).ok, true);
  const precise = await discoverProject(root, "invoke", { precise: true });
  assert.equal(precise.results[0].source, "compiler");
  assert.equal(precise.results[0].id, `compiler-fixture/${caller.id}`);
  assert.equal((await showProjectCard(root, precise.results[0].id)).node.definitions[0].symbol, "invoke");
  assert.ok((await buildContext(root, precise.results[0].id)).included.includes("auth.session.rotate"));
  await writeFile(path.join(root, "added.cts"), "export const added = true;\n");
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /source set changed/u);
  await rm(path.join(root, "added.cts"));
  await writeFile(path.join(root, "lib.mts"), "export const changed = true;\n");
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /Stale compiler analysis/u);
  const saved = await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8");
  await assert.rejects(analyzeProject(root, { language: "typescript" }));
  assert.equal(await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8"), saved);
  await assert.rejects(writeAnalysis(root, "../outside.json", result), /escapes/u);
});

test("Go type-checks local packages and separates methods and function-value shadowing", { skip: spawnSync("go", ["version"], { windowsHide: true }).status !== 0, timeout: 120000 }, async context => {
  const root = await fixture(context, {
    "go.mod": "module test.local/fixture\n\ngo 1.22\n",
    "lib/lib.go": `package lib\n${card}func Rotate(token string) string { return token }\ntype One struct{}\nfunc (One) Run() string { return Rotate("one") }\ntype Two struct{}\nfunc (Two) Run() string { return "two" }\n`,
    "main.go": '//line /virtual/ghost.go:999\npackage fixture\nimport "test.local/fixture/lib"\nfunc Invoke() string { return lib.Rotate("ok") }\nfunc Shadow() string { Rotate := func(x string) string { return x }; return Rotate("local") }\nfunc First() string { return lib.One{}.Run() }\nfunc Second() string { return lib.Two{}.Run() }\n',
  });
  const result = await analyzeProject(root, { language: "go" });
  const caller = result.graph.definitions.find(item => item.symbol === "Invoke");
  assert.equal(caller.path, "main.go");
  assert.equal(caller.line, 4);
  const shadow = result.graph.definitions.find(item => item.symbol === "Shadow");
  assert.ok(result.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  assert.equal(result.graph.references.some(edge => edge.from === shadow.id && edge.to === "auth.session.rotate"), false);
  const methods = result.graph.definitions.filter(item => item.symbol.endsWith(".Run"));
  assert.equal(methods.length, 2);
  for (const name of ["First", "Second"]) {
    const from = result.graph.definitions.find(item => item.symbol === name).id;
    assert.equal(result.graph.references.filter(edge => edge.from === from && methods.some(method => edge.to === method.id) && edge.kind === "calls").length, 1);
  }
  normalizeGraphInput(result.graph);
  assert.equal(result.diagnostics.length, 0);
});
