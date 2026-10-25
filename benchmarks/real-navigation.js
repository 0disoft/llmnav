/* llmnav/1 module
id=llmnav.eval.real-navigation
role=Measure repeatable source navigation tasks on copied real TypeScript and Go code without altering original repositories.
owns=real-source corpus provenance|retrieval condition comparison|index maintenance measurements|held model evidence
excludes=model coding success claims|human authoring time estimates|original source mutation
search=real navigation comparison|TypeScript Go pilot|retrieval time evaluation
invariant=Candidate retrieval measurements never stand in for model task completion or unmeasured human maintenance.
rel=workflow>llmnav.structure.analyze
stability=architecture
*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";
import { discoverProject } from "../src/discovery.js";
import { generateProject } from "../src/generator.js";
import { loadGraphInputs } from "../src/graph-input.js";
import { loadConfig } from "../src/config.js";
import { runCompiler } from "../src/adapters/process.js";
import { compareText, sha256, stableStringify } from "../src/util.js";
import { PACKAGE_VERSION } from "../src/spec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const conditions = ["rg", "discovery", "compiler-discovery"];

export function rankSourceCandidates(candidates, expectedPath, expectedLine) {
  const normalized = candidates.map(candidate => ({ ...candidate, path: path.posix.normalize(candidate.path.replaceAll("\\", "/")) }));
  expectedPath = path.posix.normalize(expectedPath.replaceAll("\\", "/"));
  const files = [...new Set(normalized.map(candidate => candidate.path))];
  const fileRank = files.indexOf(expectedPath) + 1;
  const definitionRank = normalized.findIndex(candidate => candidate.path === expectedPath && candidate.line === expectedLine) + 1;
  return { fileRank: fileRank || null, definitionRank: definitionRank || null, fileAt1: fileRank === 1,
    fileAt5: fileRank > 0 && fileRank <= 5, definitionAt1: definitionRank === 1, definitionAt5: definitionRank > 0 && definitionRank <= 5 };
}

export async function runRealNavigation(options) {
  const planText = await readFile(path.join(here, "real-navigation-cases.json"), "utf8");
  const plan = JSON.parse(planText);
  const report = { schemaVersion: 1, packageVersion: PACKAGE_VERSION, measuredAt: new Date().toISOString(),
    engineHash: sha256((await Promise.all(["discovery.js", "analysis.js", "graph-input.js", "adapters/typescript-worker.js", "adapters/go-analyzer.go"].map(file => readFile(path.join(here, "../src", file), "utf8")))).join("\n")),
    planHash: sha256(planText), harnessHash: sha256(await readFile(fileURLToPath(import.meta.url), "utf8")),
    environment: { platform: process.platform, arch: process.arch, node: process.version, filesystemCacheFlushed: false },
    repositories: [], externalConditions: { serena: { status: "held", reason: "No installed Serena or captured equivalent agent trial." } },
    modelTrial: { status: "held", modelAndSettings: null, taskCompletionRate: null, uncachedInputTokens: null, humanCardAuthoringSeconds: null, humanMaintenanceSeconds: null },
    limitations: ["Author-reviewed identifier and receiver-name tasks, not a sealed holdout or natural-language traffic.",
      "Actual copied production source in two bounded scopes; all source files remain unannotated.",
      "One lookup and up to five source-file inspections per condition. No autonomous code-edit completion is measured.",
      "OS caches are not flushed. The condition order rotates by task; timings include each engine boundary, not a model round trip.",
      "rg returns text match locations; discovery returns declarations/files. Definition rank measures an exact physical line, file rank deduplicates paths.",
      "Compiler setup includes analysis and generation; maintenance adds an isolated function in a disposable copy. Human maintenance is unmeasured."] };
  for (const entry of plan.repositories) {
    const original = path.resolve(entry.language === "go" ? options.goRoot : options.typescriptRoot);
    const temporary = await mkdtemp(path.join(os.tmpdir(), `llmnav-real-${entry.id}-`));
    try {
      const sources = await copyCorpus(original, temporary, entry);
      const corpusHash = digest(sources);
      const provenance = entry.language === "go" ? version("go", ["version"]) : version("git", ["-C", original, "rev-parse", "HEAD"]);
      await mkdir(path.join(temporary, ".llmnav"));
      await writeFile(path.join(temporary, ".llmnav/config.json"), stableStringify({ repositoryId: entry.id, sourceRoots: entry.sourceRoots,
        graph: { indexFiles: [".llmnav/imports/code.json"] } }));
      const analysisOptions = { language: entry.language };
      if (entry.language === "go") {
        const goVersion = provenance.match(/go(\d+\.\d+)\./u)?.[1];
        assert.ok(goVersion, "Could not identify installed Go major/minor");
        await writeFile(path.join(temporary, "go.mod"), `module llmnav-pilot/token\n\ngo ${goVersion}.0\n`);
      } else {
        await writeFile(path.join(temporary, "tsconfig.pilot.json"), stableStringify({ compilerOptions: {
          target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
          noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: true, types: [],
        }, include: ["src/scoring/**/*.ts", "src/shared/**/*.ts"] }));
        analysisOptions.project = "tsconfig.pilot.json";
      }
      const started = performance.now();
      const analysis = await analyzeProject(temporary, analysisOptions);
      await writeAnalysis(temporary, ".llmnav/imports/code.json", analysis);
      assert.equal((await generateProject(temporary)).ok, true);
      const setupMs = performance.now() - started;
      const rows = [];
      for (const [index, item] of entry.cases.entries()) {
        const source = sources.find(record => record.path === item.path)?.text;
        assert.ok(source?.includes(item.anchor), `Oracle anchor is absent: ${entry.id}/${item.id}`);
        const expectedLine = source.slice(0, source.indexOf(item.anchor)).split("\n").length;
        const rotated = [...conditions.slice(index % conditions.length), ...conditions.slice(0, index % conditions.length)];
        for (const condition of rotated) rows.push(await measureCase(temporary, entry, item, expectedLine, condition));
      }
      const definitions = new Map(analysis.graph.definitions.map(item => [item.id, item.symbol]));
      const referenceAssertions = entry.cases.filter(item => item.from).map(item => ({ id: item.id, from: item.from, to: item.to,
        passed: analysis.graph.references.some(edge => edge.kind === "calls" && definitions.get(edge.from) === item.from && definitions.get(edge.to) === item.to) }));
      assert.ok(referenceAssertions.every(item => item.passed), "Compiler call assertions failed");
      const modified = sources[0].path;
      await writeFile(path.join(temporary, modified), sources[0].text + (entry.language === "go" ? "\nfunc LLMNavPilotMarker() {}\n" : "\nexport function llmnavPilotMarker() { return 1; }\n"));
      const { config } = await loadConfig(temporary);
      const staleRejected = (await loadGraphInputs(temporary, config)).diagnostics.some(item => item.code === "LNV014");
      assert.ok(staleRejected, "Modified compiler inputs were not rejected as stale");
      const maintenanceStarted = performance.now();
      const next = await analyzeProject(temporary, analysisOptions);
      await writeAnalysis(temporary, ".llmnav/imports/code.json", next);
      assert.equal((await generateProject(temporary)).ok, true);
      const maintenanceMs = performance.now() - maintenanceStarted;
      const originalsUnchanged = digest(await readOriginals(original, sources)) === corpusHash;
      assert.ok(originalsUnchanged, "Original corpus changed while measuring");
      report.repositories.push({ id: entry.id, language: entry.language, provenance, corpusHash,
        files: sources.length, sourceBytes: sources.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
        compiler: analysis.compiler, definitions: analysis.counts.definitions, references: analysis.counts.references,
        setupMs, maintenance: { mutation: "add isolated function in disposable copy", staleRejected, reanalysisAndGenerationMs: maintenanceMs },
        originalsUnchanged, referenceAssertions, rows,
        summary: conditions.map(condition => summarizeMeasurements(rows.filter(row => row.condition === condition), condition)) });
    } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  }
  return report;
}

async function measureCase(root, entry, item, expectedLine, condition) {
  let engineSourceReadBytes = condition === "rg" ? null : 0;
  const start = performance.now();
  let candidates;
  if (condition === "rg") {
    const args = ["--json", "--fixed-strings", "--glob", entry.language === "go" ? "*.go" : "*.ts", "--", item.pattern, ...entry.sourceRoots];
    const text = await runCompiler("rg", args, { cwd: root });
    candidates = text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)).filter(record => record.type === "match")
      .map(record => ({ path: path.posix.normalize(record.data.path.text.replaceAll("\\", "/")), line: record.data.line_number }))
      .sort((left, right) => compareText(left.path, right.path) || left.line - right.line).slice(0, 5);
  } else {
    const output = await discoverProject(root, item.query, { top: 5, precise: condition === "compiler-discovery", io: {
      readFile: async (file, encoding, { signal }) => {
        const text = await readFile(file, { encoding, signal });
        if (entry.language === "go" ? file.endsWith(".go") : file.endsWith(".ts")) engineSourceReadBytes += Buffer.byteLength(text);
        return text;
      },
    } });
    candidates = output.results;
  }
  const lookupMs = performance.now() - start;
  let timeToFirstCorrectSourceMs = null, inspectedSourceBytes = 0;
  const inspectedFiles = [];
  for (const file of [...new Set(candidates.map(candidate => candidate.path))]) {
    const source = await readFile(path.join(root, file), "utf8");
    inspectedFiles.push(file); inspectedSourceBytes += Buffer.byteLength(source);
    if (file === item.path && source.includes(item.anchor)) { timeToFirstCorrectSourceMs = performance.now() - start; break; }
  }
  return { task: item.id, query: item.query, condition, lookupMs, timeToFirstCorrectSourceMs,
    ...rankSourceCandidates(candidates, item.path, expectedLine), inspectedFiles, inspectedSourceBytes, engineSourceReadBytes,
    responseBytes: Buffer.byteLength(JSON.stringify(candidates)), toolCalls: 1 + inspectedFiles.length,
    expectedPath: item.path, expectedLine, candidates: candidates.map(({ path, line, source, symbol }) => ({ path, line, source, symbol })) };
}
export function summarizeMeasurements(rows, condition) {
  const sorted = rows.map(row => row.lookupMs).sort((a,b) => a-b);
  const middle = Math.floor(sorted.length / 2);
  return { condition, cases: rows.length, fileAt1: rows.filter(row=>row.fileAt1).length, fileAt5: rows.filter(row=>row.fileAt5).length,
    definitionAt1: rows.filter(row=>row.definitionAt1).length, definitionAt5: rows.filter(row=>row.definitionAt5).length,
    medianLookupMs: sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null,
    inspectedSourceBytes: rows.reduce((sum,row)=>sum+row.inspectedSourceBytes,0),
    toolCalls: rows.reduce((sum,row)=>sum+row.toolCalls,0) };
}
export async function copyCorpus(original, target, entry) {
  const records = [];
  async function visit(relative) {
    const entries = await readdir(path.join(original, relative), { withFileTypes: true });
    entries.sort((a,b)=>compareText(a.name,b.name));
    for (const item of entries) {
      if (item.isSymbolicLink()) continue;
      const file = path.posix.join(relative === "." ? "" : relative, item.name);
      if (item.isDirectory()) { if (entry.language !== "go") await visit(file); }
      else if (item.isFile() && (entry.language === "go" ? file.endsWith(".go") && !file.endsWith("_test.go") : file.endsWith(".ts"))) {
        const text = await readFile(path.join(original, file), "utf8");
        await mkdir(path.dirname(path.join(target, file)), { recursive: true });
        await writeFile(path.join(target, file), text); records.push({ path:file, text });
      }
    }
  }
  for (const source of entry.sourceRoots) await visit(source);
  return records.sort((a,b)=>compareText(a.path,b.path));
}
export async function readOriginals(root, records) { const output=[]; for (const record of records) output.push({ path:record.path, text:await readFile(path.join(root,record.path),"utf8") }); return output; }
export function digest(sources) { return sha256(JSON.stringify(sources.map(file=>[file.path,sha256(file.text)]))); }
function version(command,args) { const result=spawnSync(command,args,{encoding:"utf8",windowsHide:true,shell:false,timeout:10000}); if(result.status!==0) throw new Error(result.stderr||"Version unavailable"); return result.stdout.trim(); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), option=name=>args[args.indexOf(name)+1];
  if (!args.includes("--typescript-root") || !args.includes("--go-root")) throw new Error("Use --typescript-root <buildmarks> --go-root <GOROOT/src/go/token> [--output <report.json>].");
  const result=await runRealNavigation({typescriptRoot:option("--typescript-root"),goRoot:option("--go-root")});
  const text=stableStringify(result);
  if (args.includes("--output")) await writeFile(option("--output"),text);
  console.log(text);
}
