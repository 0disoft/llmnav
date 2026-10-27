/* llmnav/1 module
id=llmnav.eval.policy-coding
role=Compare actual agent repairs across CLI, tool schemas and policy boundaries in frozen production-source copies.
owns=multi-file policy repair controls|frozen engine comparison|sanitized repair artifacts
excludes=blind holdout claims|automatic production patch adoption|self-reported grading
invariant=Pristine controls pass and each injected policy regression fails behaviorally before model runs begin.
stability=architecture
*/

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute, modelArguments, preflightModel, sourceSnapshot, summarizeTrace } from "./model-coding.js";
import { applyPolicyMutation, policyCases } from "./policy-cases.js";
import { sha256, stableStringify } from "../src/util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "..");
const oracle = path.join(here, "policy-oracle.js");
const supportedTools = ["llmnav_query", "llmnav_show", "llmnav_context", "llmnav_discover"];

export function policyModelArguments(root, condition, task, options) {
  const args = modelArguments(root, condition === "baseline" ? "baseline" : "llmnav-adaptive", task, options);
  if (condition !== "baseline") {
    const prefix = "mcp_servers.eval_nav.";
    args[args.findIndex(value => value.startsWith(`${prefix}args=`))] = `${prefix}args=${JSON.stringify([path.join(options.engine, "bin/llmnav.js"), "mcp", "--root", root])}`;
    args[args.findIndex(value => value.startsWith(`${prefix}enabled_tools=`))] = `${prefix}enabled_tools=${JSON.stringify(supportedTools)}`;
    args[args.length - 1] += "\nFor unclear responsibilities, LLMNav query can locate reviewed boundaries; show/context are optional for missing contracts or policy/workflow relationships. Use bounded source reads after locating a boundary. Ordinary navigation remains allowed; do not invoke semantic CLIs.";
    if (condition === "llmnav-required") args[args.length - 1] += "\nThis required-use follow-up measures semantic retrieval itself: call llmnav_query for the task with top:3 before source reads or text search. Use show/context only for missing information; do not repeat sufficient retrieval.";
  }
  return args;
}

export function normalizeRepairPatch(diff, file) {
  return diff.replaceAll("\r\n", "\n").replace(/^diff --git .*$/mu, `diff --git a/${file} b/${file}`)
    .replace(/^--- .*$/mu, `--- a/${file}`).replace(/^\+\+\+ .*$/mu, `+++ b/${file}`);
}

async function copyFiles(source, destination, files) {
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    assert.ok(!path.isAbsolute(file) && !file.split("/").includes(".."), "Unsafe corpus path");
    assert.equal((await lstat(path.join(source, file))).isSymbolicLink(), false, "Linked corpus input");
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await copyFile(path.join(source, file), path.join(destination, file));
  }
}

export function snapshotChanges(before, after) {
  const previous = new Map(before.map(item => [item.path, item.hash]));
  const next = new Map(after.map(item => [item.path, item.hash]));
  return [...new Set([...previous.keys(), ...next.keys()])].filter(file => previous.get(file) !== next.get(file)).sort();
}

async function grade(candidate, task, parent, files) {
  const grader = await mkdtemp(path.join(parent, "grader-"));
  try {
    await copyFiles(candidate, grader, files.filter(file => /^(?:src|bin|schema|templates)\//u.test(file) || file === "package.json"));
    const result = await execute(process.execPath, [oracle, grader, task.id], { cwd: grader, timeoutMs: 60000 });
    let verdict;
    try { verdict = JSON.parse(result.stdout); } catch { verdict = { passed: false, setupFailure: true }; }
    return { ...verdict, exitCode: result.code, timedOut: result.timedOut, outputHash: sha256(result.stdout + result.stderr) };
  } finally { await rm(grader, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

function policyTrace(stdout, files) {
  const trace = summarizeTrace(stdout);
  const commands = stdout.split(/\r?\n/u).flatMap(line => {
    try { const event = JSON.parse(line); return event.type === "item.completed" && typeof event.item?.command === "string" ? [event.item.command] : []; }
    catch { return []; }
  });
  const commandMetadata = commands.map(command => ({
    commandHash: sha256(command),
    category: /\b(?:rg|Select-String)\b/iu.test(command) ? "search" : /Get-Content|\b(?:cat|sed|head)\b/iu.test(command) ? "read" : "other",
    referencedFiles: files.filter(file => /^(?:src|docs)\//u.test(file) && command.replaceAll("\\", "/").includes(file)),
  }));
  return { ...trace, commandMetadata };
}

export function summarizePolicy(report) {
  assert.equal(report.complete, true, "Incomplete policy cohort");
  assert.equal(report.originalsUnchanged, true, "Original source changed");
  assert.ok(report.controls.length === policyCases.length && report.controls.every(item => item.pristine.passed === true && item.mutant.passed === false && !item.mutant.setupFailure && !item.mutant.timedOut), "Invalid policy controls");
  assert.ok(report.preflight?.writePassed && report.preflight?.llmnavPassed, "Failed model preflight");
  const expected = new Set(policyCases.flatMap(task => report.conditions.flatMap(condition => Array.from({ length: report.repetitions }, (_, repetition) => `${task.id}/${condition}/${repetition}`))));
  for (const row of report.rows) assert.ok(expected.delete(`${row.task}/${row.condition}/${row.repetition}`), "Duplicate or unknown observation");
  assert.equal(expected.size, 0, "Missing policy observations");
  const knownSum = values => values.every(value => Number.isFinite(value) && value >= 0) ? values.reduce((sum, value) => sum + value, 0) : null;
  return report.conditions.map(condition => {
    const rows = report.rows.filter(row => row.condition === condition);
    const input = knownSum(rows.map(row => row.trace.usage?.input_tokens));
    const cached = knownSum(rows.map(row => row.trace.usage?.cached_input_tokens));
    return { condition, attempts: rows.length, successes: rows.filter(row => row.success).length,
      acceptancePasses: rows.filter(row => row.acceptance.passed).length, scopeFailures: rows.filter(row => !row.scopePassed).length,
      timeouts: rows.filter(row => row.timedOut).length, conditionViolations: rows.filter(row => !row.conditionAdhered).length,
      navigationAttempts: rows.filter(row => row.navigationUsed).length, totalElapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
      inputTokens: input, cachedInputTokens: cached, uncachedInputTokens: knownSum(rows.map(row => row.trace.uncachedInputTokens)),
      cacheShare: input > 0 && cached !== null ? cached / input : null,
      outputTokens: knownSum(rows.map(row => row.trace.usage?.output_tokens)),
      toolEvents: rows.reduce((sum, row) => sum + row.trace.tools.length, 0),
      responseBytes: rows.flatMap(row => row.trace.tools).reduce((sum, tool) => sum + tool.responseBytes, 0),
      mcpFailures: rows.flatMap(row => row.trace.tools).filter(tool => tool.type === "mcp_tool_call" && (tool.toolError || tool.status !== "completed")).length };
  });
}

export async function runPolicyCoding(options) {
  const source = path.resolve(options.source ?? repository);
  const repetitions = options.repetitions ?? 1;
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3, "Repetitions must be 1..3");
  const conditions = options.conditions ?? ["baseline", "llmnav"];
  assert.ok(conditions.length && new Set(conditions).size === conditions.length &&
    conditions.every(condition => ["baseline", "llmnav", "llmnav-required"].includes(condition)), "Invalid policy conditions");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: source, encoding: "utf8" }).split("\0").filter(file =>
    file && !file.startsWith("benchmarks/") && !/^\.env(?:\.|$)/u.test(file) && !/\.(?:tgz|zip|log)$/u.test(file));
  const sourceBefore = await Promise.all(files.map(async file => ({ path: file, hash: sha256(await readFile(path.join(source, file))) })));
  const temporary = path.join(repository, ".llmnav/tmp");
  await mkdir(temporary, { recursive: true });
  const parent = await mkdtemp(path.join(temporary, "policy-coding-"));
  const template = path.join(parent, "corpus"), engine = path.join(parent, "engine");
  await copyFiles(source, template, files);
  const engineSource = path.resolve(options.engine ?? source);
  await copyFiles(engineSource, engine, files.filter(file => /^(?:src|bin|schema|templates)\//u.test(file) || file === "package.json"));
  const report = { schemaVersion: 1, kind: "multi-file-policy-coding", measuredAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
    sourceHash: sha256(stableStringify(sourceBefore)), sourceFiles: files.length, conditions, repetitions,
    model: { requested: options.model ?? "gpt-6.1-sol", reasoningEffort: "high", resolvedProviderModel: null },
    environment: { node: process.version, platform: process.platform, codex: (await execute("codex", ["--version"])).stdout.trim() },
    methodology: { concurrency: 1, timeoutMs: options.timeoutMs ?? 240000, order: "alternate conditions by task and repetition",
      existingCards: true, annotationCostMeasured: false, cacheControlled: false, grading: "separate production-only copy; fixed hidden boundary checks",
      isolation: "workspace-write and prompt-enforced path/tool restrictions; not adversarial isolation" },
    engines: {}, harnessHashes: {}, controls: [], rows: [], complete: false, originalsUnchanged: null,
    limitations: ["Two author-curated multi-file regressions in LLMNav's own annotated production code, not discovered incidents, blind holdouts or cross-project evidence.",
      "Task difficulty, repeated-task familiarity and uncontrolled provider caching limit causal attribution; byte counts are not token counts.",
      "Existing annotation/index construction and maintenance costs, monetary cost and resolved provider model are unmeasured."] };
  const save = () => writeFile(options.output, stableStringify(report));
  try {
    for (const file of ["policy-coding.js", "policy-cases.js", "policy-oracle.js", "model-coding.js"]) report.harnessHashes[file] = sha256(await readFile(path.join(here, file)));
    for (const file of files.filter(file => file.startsWith("src/"))) report.engines[file] = sha256(await readFile(path.join(engine, file)));
    for (const task of policyCases) {
      const pristine = await grade(template, task, parent, files);
      assert.ok(pristine.passed && !pristine.setupFailure, `Pristine oracle failed: ${task.id} ${JSON.stringify(pristine)}`);
      for (const [file, before, after] of task.mutations) await writeFile(path.join(template, file), applyPolicyMutation(await readFile(path.join(template, file), "utf8"), before, after));
      let mutant;
      try { mutant = await grade(template, task, parent, files); }
      finally { for (const [file] of task.mutations) await copyFile(path.join(source, file), path.join(template, file)); }
      assert.ok(!mutant.passed && !mutant.setupFailure && !mutant.timedOut, `Invalid mutant control: ${task.id}`);
      report.controls.push({ task: task.id, pristine, mutant });
      console.log(JSON.stringify({ control: task.id, pristine: pristine.passed, mutant: mutant.passed }));
    }
    await save();
    if (options.controlsOnly) return report;
    report.preflight = await preflightModel({ conditions: ["llmnav-before"], beforeMode: true, beforeCli: path.join(engine, "bin/llmnav.js"), model: report.model.requested, timeoutMs: report.methodology.timeoutMs }, parent);
    await save();
    assert.ok(report.preflight.writePassed && report.preflight.llmnavPassed, "Model preflight failed; stop before scoring");
    for (let repetition = 0; repetition < repetitions; repetition += 1) for (const [index, task] of policyCases.entries()) {
      const order = (index + repetition) % 2 ? [...conditions].reverse() : conditions;
      for (const condition of order) {
        const root = await mkdtemp(path.join(parent, "attempt-"));
        try {
          await copyFiles(template, root, files);
          for (const [file, before, after] of task.mutations) await writeFile(path.join(root, file), applyPolicyMutation(await readFile(path.join(root, file), "utf8"), before, after));
          const before = await sourceSnapshot(root);
          const repairBefore = new Map(await Promise.all(task.mutations.map(async ([file]) => [file, await readFile(path.join(root, file), "utf8")])));
          const result = await execute("codex", policyModelArguments(root, condition, task, { model: report.model.requested, engine }), { cwd: root, timeoutMs: report.methodology.timeoutMs });
          const trace = policyTrace(result.stdout, files);
          const changedFiles = snapshotChanges(before, await sourceSnapshot(root));
          const acceptance = await grade(root, task, parent, files);
          const scopePassed = changedFiles.length >= 2 && changedFiles.every(file => /^src\/.*\.js$/u.test(file));
          const navigationUsed = trace.tools.some(tool => tool.type === "mcp_tool_call" && supportedTools.includes(tool.tool) && tool.status === "completed" && !tool.toolError);
          const conditionAdhered = !trace.tools.some(tool => tool.semanticCliMentioned) &&
            (condition !== "llmnav-required" || navigationUsed);
          const row = { task: task.id, language: task.language, repetition, condition, elapsedMs: result.elapsedMs,
            exitCode: result.code, timedOut: result.timedOut, changedFiles, scopePassed, conditionAdhered, navigationUsed, trace, acceptance,
            success: acceptance.passed && scopePassed && conditionAdhered && trace.completed && result.code === 0 && !result.timedOut,
            stderrHash: sha256(result.stderr), patches: [] };
          for (const file of changedFiles.filter(file => /^src\/.*\.js$/u.test(file))) {
            const original = path.join(parent, "patch-before", file);
            await mkdir(path.dirname(original), { recursive: true });
            await writeFile(original, repairBefore.get(file) ?? await readFile(path.join(template, file), "utf8"));
            const diff = await execute("git", ["diff", "--no-index", "--no-prefix", "--", original, path.join(root, file)], { cwd: parent });
            assert.ok(diff.code === 0 || diff.code === 1, "Could not capture repair patch");
            const patch = normalizeRepairPatch(diff.stdout, file).replaceAll(root, "<workspace>");
            const patchName = `${path.basename(options.output, ".json")}-${task.id}-${condition}-${repetition}-${file.replaceAll("/", "_")}.patch`;
            await writeFile(path.join(path.dirname(options.output), patchName), patch);
            row.patches.push({ file, artifact: patchName, hash: sha256(patch) });
          }
          report.rows.push(row); await save();
          console.log(JSON.stringify({ task: task.id, repetition, condition, success: row.success, navigationUsed, changedFiles, uncachedInputTokens: trace.uncachedInputTokens, elapsedMs: row.elapsedMs }));
        } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      }
    }
    report.complete = true;
  } finally {
    report.originalsUnchanged = (await Promise.all(sourceBefore.map(async item => sha256(await readFile(path.join(source, item.path))) === item.hash))).every(Boolean);
    if (report.complete) report.summary = summarizePolicy(report);
    await save();
    assert.equal(path.dirname(parent), temporary, "Unsafe evaluation cleanup");
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  assert.ok(args.includes("--output"), "Supply --output <report.json>");
  await runPolicyCoding({ output: path.resolve(value("--output")), controlsOnly: args.includes("--controls-only"),
    repetitions: args.includes("--repetitions") ? Number(value("--repetitions")) : 1,
    conditions: args.includes("--conditions") ? value("--conditions").split(",") : undefined,
    engine: args.includes("--engine") ? value("--engine") : undefined });
}
