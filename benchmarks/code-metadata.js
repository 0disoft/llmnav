/* llmnav/1 module
id=llmnav.eval.metadata
role=Measure opt-in compiler metadata costs and bounded retrieval against explicit source facts.
owns=metadata comparison fixtures|real declaration probes|synthetic member lookup measurements
excludes=model token accounting|project execution|dependency installation|semantic card validation
search=metadata benchmark|signature accuracy|member page costs
invariant=Script observations distinguish output bytes and synthetic lookup costs from real agent token use.
rel=workflow>llmnav.structure.analyze
rel=workflow>llmnav.structure.metadata
stability=architecture
*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";
import { codeMetadataPage } from "../src/code-metadata.js";
import { generateProject } from "../src/generator.js";
import { createProjectSession, showProjectCard } from "../src/search.js";
import { getAgentToolDefinitions } from "../src/agent-tools.js";
import { sha256 } from "../src/util.js";

const repository = fileURLToPath(new URL("..", import.meta.url));
const realTypes = await readFile(path.join(repository, "src/index.d.ts"), "utf8");
const realSpec = await readFile(path.join(repository, "src/spec.d.ts"), "utf8");
const realGo = (await readFile(path.join(repository, "src/adapters/go-analyzer.go"), "utf8")).replace(/\/\* llmnav\/1[\s\S]*?\*\//gu, "");
const fixtureTypes = "export class Store { count: number = 0; save(label: string, ...flags: boolean[]): number { return label.length + flags.length; } }\n";
const fixtureGo = "package metadata\ntype Store struct { Count int }\nfunc (s *Store) Save(label string, flags ...bool) int { return s.Count }\n";
const cases = [
  { name: "typescript-fixture", language: "typescript", source: fixtureTypes, target: "Store.save", owner: "Store", parameter: "label", field: "count", fieldType: "number" },
  { name: "typescript-llmnav", language: "typescript", source: realTypes, declarationFile: true, target: "analyzeProject", parameter: "root", field: "metadataBudget", fieldType: "number" },
  { name: "go-fixture", language: "go", source: fixtureGo, target: "Store.Save", owner: "Store", parameter: "label", field: "Count", fieldType: "int" },
  { name: "go-llmnav", language: "go", source: realGo, target: "analyzer.collect", owner: "analyzer", parameter: "name", field: "Variadic", fieldType: "bool" },
];
const observations = [];
for (const entry of cases) observations.push(await observe(entry));
const definitions = getAgentToolDefinitions();
const compactDefinitions = structuredClone(definitions);
const show = compactDefinitions.find(item => item.name === "llmnav_show");
for (const key of ["metadata", "members", "top", "offset", "metadataBudget"]) delete show.inputSchema.properties[key];
const result = {
  schemaVersion: 1,
  environment: { node: process.version, platform: process.platform, arch: process.arch,
    go: spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true }).stdout.trim() },
  method: "Two alternating analysis runs per mode; median elapsed milliseconds. Generation is full for both modes. Single-machine observations, not statistical speedup claims. Real code is copied into isolated projects; the Go semantic card is removed. Source updates rerun the complete compiler analysis.",
  observations,
  synthetic: synthetic(50000, 100),
  toolDefinitions: { bytes: bytes(definitions), withoutMetadataOptionsBytes: bytes(compactDefinitions), addedBytes: bytes(definitions) - bytes(compactDefinitions) },
  limitations: ["No model calls or provider token counts.", "Full-metadata output and linear scans are synthetic references, not measured ordinary-agent navigation.", "Default response compatibility does not imply unchanged graph loading time or storage.", "Compiler/OS caches and single-run update timings affect measurements."] ,
};
if (process.argv[2]) {
  const output = path.resolve(process.argv[2]);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));

async function observe(entry) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-metadata-bench-"));
  try {
    await mkdir(path.join(root, ".llmnav"));
    await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "metadata", graph: { indexFiles: [".llmnav/imports/code.json"] } }));
    const file = entry.language === "go" ? "main.go" : entry.declarationFile ? "main.d.ts" : "main.ts";
    await writeFile(path.join(root, file), entry.source);
    if (entry.declarationFile) await writeFile(path.join(root, "spec.d.ts"), realSpec);
    if (entry.language === "go") await writeFile(path.join(root, "go.mod"), "module test.local/metadata\n\ngo 1.22\n");
    const times = { legacy: [], metadata: [] }, analyses = {};
    for (const order of [[false, true], [true, false]]) {
      for (const metadata of order) {
        const name = metadata ? "metadata" : "legacy";
        const measured = await timed(() => analyzeProject(root, { language: entry.language, metadata }));
        times[name].push(measured.ms); analyses[name] = measured.value;
      }
    }
    const legacy = analyses.legacy, detailed = analyses.metadata;
    assert.deepEqual({ ...detailed.graph, schemaVersion: 2, definitions: detailed.graph.definitions.map(({ metadata, ...item }) => item) }, legacy.graph);
    const target = detailed.graph.definitions.find(item => item.symbol === entry.target);
    assert.ok(target, entry.target);
    const metadata = target.metadata;
    const parameter = metadata.parameters.find(item => item.name === entry.parameter);
    assert.equal(parameter.type, "string");
    assert.equal(parameter.typeOrigin, "declared");
    assert.ok(metadata.signatures.length > 0);
    const field = detailed.graph.definitions.find(item => item.symbol === entry.field && item.metadata.category === "field");
    assert.ok(field.metadata.type.includes(entry.fieldType));
    assert.equal(metadata.status, "available");
    if (entry.owner) assert.equal(metadata.owner, detailed.graph.definitions.find(item => item.symbol === entry.owner).id);
    const modes = {};
    for (const [name, analysis] of [["legacy", legacy], ["metadata", detailed]]) {
      await writeAnalysis(root, ".llmnav/imports/code.json", analysis);
      const generated = await timed(() => generateProject(root, { incremental: false }));
      assert.equal(generated.value.ok, true);
      const shown = await timed(() => showProjectCard(root, target.id));
      modes[name] = { analysisMs: median(times[name]), fullGenerationMs: generated.ms,
        compilerInputBytes: bytes(analysis.graph), cacheBytes: await directoryBytes(path.join(root, ".llmnav/cache")),
        defaultShowMs: shown.ms, defaultShowBytes: bytes(shown.value) };
    }
    assert.equal(modes.legacy.defaultShowBytes, modes.metadata.defaultShowBytes);
    const session = await createProjectSession(root);
    const lookup = await timed(() => session.show(target.id, { metadata: true }));
    const warm = await timed(() => session.show(target.id, { metadata: true }));
    assert.ok(lookup.value.metadata.items[0].metadata, "target fits in its metadata budget");
    const unchanged = await timed(() => generateProject(root));
    await writeFile(path.join(root, file), `${entry.source}\n`);
    const update = await timed(() => analyzeProject(root, { language: entry.language, metadata: true }));
    await writeAnalysis(root, ".llmnav/imports/code.json", update.value);
    const regenerated = await timed(() => generateProject(root));
    assert.equal(regenerated.value.ok, true);
    return { name: entry.name, compiler: detailed.compiler, sourceSha256: sha256(entry.source), sourceBytes: Buffer.byteLength(entry.source),
      definitions: detailed.counts.definitions, references: detailed.counts.references, checkedFacts: entry.owner ? 6 : 5, correctFacts: entry.owner ? 6 : 5,
      ...modes, detail: { coldSessionShowMs: lookup.ms, warmSessionShowMs: warm.ms, responseBytes: bytes(lookup.value), pageBytes: bytes(lookup.value.metadata), callsAfterKnownId: 1 },
      update: { unchangedGenerationMs: unchanged.ms, fullReanalysisMs: update.ms, generationAfterEditMs: regenerated.ms } };
  } finally { await rm(root, { recursive: true, force: true }); }
}

function synthetic(count, requests) {
  const metadata = { language: "typescript", category: "type", owner: null, status: "available", type: "Store", typeOrigin: "declared", signatures: [], parameters: [] };
  const owner = "metadata/type.store";
  const graph = { nodes: [{ key: owner, definitions: [{ symbol: "Store", path: "large.ts", line: 1, kind: "ClassDeclaration", metadata }] },
    ...Array.from({ length: count }, (_, i) => ({ key: `metadata/field.f${String(i).padStart(6, "0")}`, definitions: [
      { symbol: `field${i}`, path: "large.ts", line: i + 2, kind: "PropertyDeclaration", metadata: { ...metadata, owner, category: "field", type: "string" } },
    ] }))] };
  const options = { members: true, top: 5, metadataBudget: 4000 };
  const start = performance.now();
  const page = codeMetadataPage(graph, owner, options);
  const coldMs = performance.now() - start;
  const startWarm = performance.now();
  for (let i = 0; i < requests; i++) assert.deepEqual(codeMetadataPage(graph, owner, options), page);
  const warmTotalMs = performance.now() - startWarm;
  const startLinear = performance.now();
  for (let i = 0; i < requests; i++) {
    let found = 0;
    for (const node of graph.nodes) for (const item of node.definitions) if (item.metadata.owner === owner) found++;
    assert.equal(found, count);
  }
  const linearTotalMs = performance.now() - startLinear;
  return { definitions: count + 1, requests, coldIndexedPageMs: round(coldMs), warmIndexedTotalMs: round(warmTotalMs),
    linearCountReferenceTotalMs: round(linearTotalMs), fullMetadataBytes: bytes(graph.nodes), pageBytes: bytes(page), pageItems: page.items.length,
    fullMetadataCalls: 1, onePageCalls: 1, enumerateAllPagesMinimumCalls: Math.ceil(count / options.top) };
}
async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(file) : (await stat(file)).size;
  }
  return total;
}
async function timed(work) { const start = performance.now(); const value = await work(); return { value, ms: round(performance.now() - start) }; }
function median(values) { return round((values[0] + values[1]) / 2); }
function round(value) { return Math.round(value * 1000) / 1000; }
function bytes(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
