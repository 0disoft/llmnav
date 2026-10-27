import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeGo } from "../src/adapters/go.js";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";
import { loadConfig } from "../src/config.js";
import { loadGraphInputs } from "../src/graph-input.js";
import { sha256 } from "../src/util.js";

const goMissing = spawnSync("go", ["version"], { windowsHide: true }).status !== 0;
async function fixture(context, sources) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-go-positions-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "go-positions", graph: { indexFiles: [".llmnav/imports/code.json"] } }));
  await writeFile(path.join(root, "go.mod"), "module test.local/positions\n\ngo 1.22\n");
  for (const [file, source] of Object.entries(sources)) await writeFile(path.join(root, file), source);
  return root;
}
const card = id => "/* llmnav/1 symbol\nid=" + id + "\nrole=Perform a distinct operation.\nsearch=operation execution|method entry\nstability=contract\n*/\n";

test("Go offsets use UTF-16 across BOM, Unicode, CRLF and ASCII files while retaining byte keys", { skip: goMissing, timeout: 120000 }, async context => {
  const sources = {
    "main.go": '\ufeffpackage fixture\r\nconst text = "한글😀\u0085\u2028\u2029"\r\ntype Store struct { Count int; 이름 string }\r\n//line /virtual/ghost.go:400\r\nfunc (self Store) Read(value string) string { return value }\r\n',
    "plain.go": "package fixture\nfunc Plain(input int) int { return input }\n",
  };
  const root = await fixture(context, sources);
  const files = Object.keys(sources).map(file => path.join(root, file));
  const raw = await analyzeGo(root, files, { metadata: true });
  for (const [file, source] of Object.entries(sources)) assert.equal(raw.configHashes[file], sha256(Buffer.from(source)));
  for (const row of raw.declarations) {
    if (row.kind === "module") { assert.equal(row.offset, -1); continue; }
    const source = sources[row.path];
    assert.equal(source.slice(row.offset, row.offset + row.symbol.length), row.symbol, row.symbol);
    assert.equal(row.key, row.path + ":" + Buffer.byteLength(source.slice(0, row.offset)), row.symbol);
    assert.equal(row.line, source.slice(0, row.offset).split("\n").length, row.symbol);
  }
  const owner = raw.declarations.find(row => row.symbol === "Store");
  const method = raw.declarations.find(row => row.symbol === "Read");
  assert.equal(method.metadata.owner, owner.key);
  assert.equal(raw.declarations.find(row => row.symbol === "value").parent, method.key);
  assert.equal(raw.declarations.find(row => row.symbol === "Plain").offset, sources["plain.go"].indexOf("Plain"));
  await writeFile(files[0], "package fixture\nfunc Broken( {\n");
  await assert.rejects(analyzeGo(root, files), /expected|syntax/u);
});

test("Go Unicode byte offsets cannot collide with another reviewed method card", { skip: goMissing, timeout: 120000 }, async context => {
  const source = 'package fixture\nconst text = "' + "한".repeat(78) + '"\ntype One struct{}\ntype Two struct{}\n' +
    card("method.first") + "func (One) Run() int { return 1 }\n" +
    card("method.second") + "func (Two) Run() int { return 2 }\nfunc Invoke() int { return One{}.Run() }\n";
  // The first method's byte location equals the second card's UTF-16 location.
  assert.equal(Buffer.byteLength(source.slice(0, source.indexOf("Run()"))), source.indexOf("func (Two)"));
  const root = await fixture(context, { "main.go": source });
  const result = await analyzeProject(root, { language: "go", metadata: true });
  assert.equal(result.counts.cardBindings, 2);
  assert.equal(result.graph.definitions.find(row => row.symbol === "One.Run").id, "method.first");
  assert.equal(result.graph.definitions.find(row => row.symbol === "Two.Run").id, "method.second");
  const caller = result.graph.definitions.find(row => row.symbol === "Invoke");
  assert.ok(result.graph.references.some(edge => edge.from === caller.id && edge.to === "method.first" && edge.kind === "calls"));
  const output = ".llmnav/imports/code.json";
  await writeAnalysis(root, output, result);
  const { config } = await loadConfig(root);
  assert.equal((await loadGraphInputs(root, config)).diagnostics.length, 0);
  assert.equal(JSON.parse(await readFile(path.join(root, output), "utf8")).references.some(edge => edge.to === "method.first" && edge.kind === "calls"), true);
});
