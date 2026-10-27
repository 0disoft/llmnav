/* llmnav/1 module
id=llmnav.eval.local-analysis
role=Measure additional language metadata and on-demand provenance costs in disposable repositories.
owns=additional language fixtures|history lookup observations|verification receipt costs
excludes=model token accounting|application execution|dependency installation
search=Python Rust JavaScript metadata evaluation|history verification benchmark
invariant=Measurements use disposable inputs and never equate output bytes with actual model tokens.
rel=workflow>llmnav.structure.analyze
rel=workflow>llmnav.evidence.history
rel=workflow>llmnav.evidence.verification
stability=architecture
*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";
import { generateProject } from "../src/generator.js";
import { createProjectSession } from "../src/search.js";
import { codeMetadataPage } from "../src/code-metadata.js";
import { getFileHistory } from "../src/git-history.js";
import { captureVerificationSnapshot, recordVerification, getVerification } from "../src/verification.js";
import { sha256 } from "../src/util.js";

const stripCards = source => source.replace(/\/\* llmnav\/1[\s\S]*?\*\//gu, "");
const cases = [
  { language: "javascript", file: "main.mjs", target: "save", type: "string", origin: "declared",
    source: "/** @param {string} label */\nexport function save(label) { return label.length; }\n" },
  { language: "javascript", file: "tokenizer.mjs", target: "normalizeSearchText", type: null, origin: "unknown", real: "src/tokenizer.js",
    source: stripCards(await readFile(new URL("../src/tokenizer.js", import.meta.url), "utf8")) },
  { language: "python", file: "main.py", target: "Store.save", type: "str", origin: "declared",
    source: "class Store:\n    count: int = 1\n    def save(self, label: str) -> str:\n        return label\n" },
  { language: "rust", file: "main.rs", target: "Store.save", type: "&str", origin: "declared",
    source: "pub struct Store { pub count: i32 }\nimpl Store { pub fn save(&self, label: &str) -> i32 { self.count } }\n" },
];
const observations = [];
for (const entry of cases) observations.push(await observe(entry));
const result = { schemaVersion: 1, environment: { node: process.version, platform: process.platform, arch: process.arch },
  method: "One sequential local run per case/mode; wall times include subprocess startup. Baseline means the same adapter without metadata, not a historical release or ordinary agent task. Script byte counts are compact UTF-8 JSON, not model tokens.",
  observations, large: large(), provenance: await provenance(),
  limitations: ["Single-machine timings with warm filesystem/toolchain caches; no statistical speedup claim.",
    "Python and Rust syntax facts do not imply type checking or call resolution. Source updates rerun full language analysis; compiler-level incremental refresh is not implemented.",
    "No real agent/model experiment; raw source/full graphs are byte references, not a matched-task token baseline."] };
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

async function observe(entry) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-language-bench-"));
  try {
    await mkdir(path.join(root, ".llmnav"));
    await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "bench", graph: { indexFiles: [".llmnav/imports/code.json"] } }));
    await writeFile(path.join(root, entry.file), entry.source);
    const options = { language: entry.language };
    const legacy = await timed(() => analyzeProject(root, options));
    const detailed = await timed(() => analyzeProject(root, { ...options, metadata: true }));
    const analysis = detailed.value;
    assert.deepEqual({ ...analysis.graph, schemaVersion: 2, definitions: analysis.graph.definitions.map(({ metadata, ...row }) => row) }, legacy.value.graph);
    const target = analysis.graph.definitions.find(row => row.symbol === entry.target);
    assert.ok(target, entry.target);
    const parameter = target.metadata.parameters.at(-1);
    assert.equal(parameter.type, entry.type);
    assert.equal(parameter.typeOrigin, entry.origin);
    assert.ok(target.metadata.signatures.length);
    normalizePrecision(analysis, entry.language);
    const generations = {};
    for (const [mode, value] of [["legacy", legacy.value], ["metadata", analysis]]) {
      await writeAnalysis(root, ".llmnav/imports/code.json", value);
      const generated = await timed(() => generateProject(root, { incremental: false }));
      assert.equal(generated.value.ok, true);
      generations[mode] = generated.ms;
    }
    const session = await createProjectSession(root);
    const plain = await timed(() => session.show(target.id));
    const cold = await timed(() => session.show(target.id, { metadata: true }));
    const warm = await timed(() => session.show(target.id, { metadata: true }));
    await writeFile(path.join(root, entry.file), `${entry.source}\n`);
    const update = await timed(() => analyzeProject(root, { ...options, metadata: true }));
    await writeAnalysis(root, ".llmnav/imports/code.json", update.value);
    const regeneration = await timed(() => generateProject(root));
    assert.equal(regeneration.value.ok, true);
    return { language: entry.language, input: entry.real ?? "fixture", analyzer: analysis.compiler, precision: analysis.precision ?? "compiler",
      sourceSha256: sha256(entry.source), sourceBytes: Buffer.byteLength(entry.source), checkedFacts: 4, correctFacts: 4,
      definitions: analysis.counts.definitions, references: analysis.counts.references, diagnostics: analysis.diagnostics.length,
      legacyAnalysisMs: legacy.ms, metadataAnalysisMs: detailed.ms, generationMs: generations,
      legacyGraphBytes: bytes(legacy.value.graph), metadataGraphBytes: bytes(analysis.graph),
      defaultShowBytes: bytes(plain.value), detailedShowBytes: bytes(cold.value), knownIdDetailCalls: 1,
      coldDetailMs: cold.ms, warmDetailMs: warm.ms, fullReanalysisMs: update.ms, generationAfterEditMs: regeneration.ms };
  } finally { await rm(root, { recursive: true, force: true }); }
}
function normalizePrecision(analysis, language) {
  assert.equal(analysis.precision ?? "compiler", language === "javascript" ? "compiler" : "syntax");
}
function large() {
  const owner = "bench/type.store", count = 50000;
  const metadata = { language: "rust", precision: "syntax", category: "field", owner, status: "partial", type: "i32", typeOrigin: "declared", signatures: [], parameters: [] };
  const graph = { nodes: Array.from({ length: count }, (_, i) => ({ key: `bench/field.s${i}`, definitions: [{ symbol: `field${i}`, path: "large.rs", line: i + 1, metadata }] })) };
  graph.nodes.unshift({ key: owner, definitions: [{ symbol: "Store", path: "large.rs", line: 1, metadata: { ...metadata, category: "type", owner: null } }] });
  const start = performance.now();
  const page = codeMetadataPage(graph, owner, { members: true, top: 5 });
  const coldMs = performance.now() - start;
  const warmStart = performance.now();
  for (let i = 0; i < 100; i++) assert.equal(codeMetadataPage(graph, owner, { members: true, top: 5 }).items.length, 5);
  const warmMs = performance.now() - warmStart;
  return { definitions: count + 1, pageItems: page.items.length, fullGraphBytes: bytes(graph), pageBytes: bytes(page), coldPageMs: round(coldMs), warm100PagesMs: round(warmMs), allPagesMinimumCalls: count / 5 };
}
async function provenance() {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-provenance-bench-"));
  try {
    const git = args => {
      const command = spawnSync("git", ["-c", "core.hooksPath=.git/disabled-hooks", "-c", "commit.gpgsign=false", ...args], {
        cwd: root, windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_AUTHOR_NAME: "LLMNav fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "LLMNav fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
      });
      assert.equal(command.status, 0, command.stderr);
    };
    git(["init", "-q"]);
    await writeFile(path.join(root, "source.js"), "export const size = 1;\n");
    git(["add", "source.js"]); git(["commit", "-qm", "fixture"]);
    const cold = await timed(() => getFileHistory(root, "source.js"));
    const warm = await timed(() => getFileHistory(root, "source.js"));
    assert.equal(cold.value.lastChange.commit, warm.value.lastChange.commit);
    await writeFile(path.join(root, "evidence.txt"), "benchmark fixture evidence\n");
    const snapshot = await timed(() => captureVerificationSnapshot(root, ["source.js"], { completeInputs: true }));
    const record = await timed(() => recordVerification(root, { snapshot: snapshot.value, command: ["benchmark-fixture"], outcome: "unknown", evidence: ["evidence.txt"] }));
    const read = await timed(() => getVerification(root, record.value.id));
    assert.equal(read.value.applicability, "matches");
    await writeFile(path.join(root, "source.js"), "export const size = 2;\n");
    assert.equal((await getVerification(root, record.value.id)).applicability, "stale");
    assert.equal((await getFileHistory(root, "source.js")).dirty.unstaged, true);
    return { coldHistoryMs: cold.ms, warmHistoryMs: warm.ms, historyBytes: bytes(warm.value), snapshotMs: snapshot.ms,
      recordMs: record.ms, readMs: read.ms, receiptBytes: bytes(record.value.receipt), summaryBytes: bytes(read.value),
      outcome: read.value.outcome, matchingInputs: read.value.applicability, changedInputs: "stale" };
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function timed(work) { const start = performance.now(); const value = await work(); return { value, ms: round(performance.now() - start) }; }
function bytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
function round(value) { return Math.round(value * 1000) / 1000; }
