/* llmnav/1 module
id=llmnav.eval.model-coding
role=Grade actual model edits on isolated mutated real source with acceptance tests unavailable in the model workspace.
owns=coding outcome oracles|condition rotation|sanitized tool traces|model usage accounting
excludes=production source modification|sealed holdout claims|self-reported success grading
search=model coding evaluation|Serena agent comparison|baseline coding trial
invariant=Every scored mutation first passes a pristine-positive and mutant-negative oracle control.
stability=architecture
*/

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { codingCases, mutateSource } from "./coding-cases.js";
import { prepareCorpus } from "./evaluation-corpus.js";
import { digest, readOriginals } from "./real-navigation.js";
import { serenaArguments, stopProcessTree, SERENA_VERSION } from "./mcp-client.js";
import { sha256, stableStringify } from "../src/util.js";
import { PACKAGE_VERSION } from "../src/spec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "../bin/llmnav.js");
const tsc = path.join(here, "../node_modules/typescript/bin/tsc");
const defaultConditions = ["baseline", "llmnav", "serena"];
const entries = JSON.parse(await readFile(path.join(here, "real-navigation-cases.json"), "utf8")).repositories;

export function summarizeTrace(stdout) {
  const events = stdout.split(/\r?\n/u).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const tools = events.filter(event => event.type === "item.completed" && ["command_execution", "mcp_tool_call", "file_change", "web_search"].includes(event.item?.type))
    .map(({ item }) => ({ type: item.type, tool: item.tool ?? null, server: item.server ?? null,
      commandHash: typeof item.command === "string" ? sha256(item.command) : null,
      semanticCliMentioned: typeof item.command === "string" && /(?:npm\s+exec[^\n]*llmnav|bunx\s+llmnav|bin[/\\]llmnav\.js|\b(?:llmnav|serena)\s+(?:query|discover|show|context|find_symbol))/u.test(item.command),
      status: item.status ?? null, exitCode: item.exit_code ?? null, toolError: Boolean(item.error || item.result?.isError || item.result?.is_error),
      discovery: item.tool === "llmnav_discover" ? discoveryMetrics(item) : null,
      errorCategory: /requires approval/u.test(item.error?.message ?? "") ? "approval_required" : item.error ? "tool_error" : null,
      responseBytes: Buffer.byteLength(typeof item.aggregated_output === "string" ? item.aggregated_output : JSON.stringify(item.result ?? item.error ?? null)) }));
  const completed = events.findLast(event => event.type === "turn.completed");
  const usage = completed?.usage ?? null;
  const itemTypes = {};
  for (const event of events.filter(event => event.type === "item.completed")) {
    const type = event.item?.type ?? "unknown";
    itemTypes[type] = (itemTypes[type] ?? 0) + 1;
  }
  return { completed: Boolean(completed), usage, tools, itemTypes,
    uncachedInputTokens: usage && Number.isFinite(usage.cached_input_tokens) ? usage.input_tokens - usage.cached_input_tokens : null,
    errors: events.filter(event => event.type === "error" || event.type === "turn.failed").length };
}

function discoveryMetrics(item) {
  const content = item.result?.content?.find(block => block.type === "text")?.text;
  let data;
  try { data = JSON.parse(content).data; } catch { return { parsed: false }; }
  const results = Array.isArray(data?.results) ? data.results : [];
  const excerpts = results.flatMap(candidate => candidate.sourceExcerpt ? [candidate.sourceExcerpt] : []);
  return { parsed: true, candidates: results.length, excerpts: excerpts.length,
    sourceBytes: excerpts.reduce((sum, excerpt) => sum + Buffer.byteLength(excerpt.text), 0),
    truncatedExcerpts: excerpts.filter(excerpt => excerpt.truncated).length };
}

async function execute(command, args, { cwd, timeoutMs = 90000, env = process.env } = {}) {
  const started = performance.now();
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; void stopProcessTree(child); }, timeoutMs);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, elapsedMs: performance.now() - started }); });
  });
}

async function grade(root, entry, task) {
  const grader = await mkdtemp(path.join(os.tmpdir(), "llmnav-private-grader-"));
  try {
    // Only current production sources cross the boundary. Model-owned scripts,
    // dependencies, configs and tests never execute in the acceptance grader.
    await prepareCorpus(root, grader, entry);
    if (entry.language === "go") {
      await writeFile(path.join(grader, "acceptance_test.go"), task.test);
      const result = await execute("go", ["test", "-count=1", "-run", "^TestAcceptance$", "."], { cwd: grader });
      return { passed: result.code === 0 && !result.timedOut, exitCode: result.code, timedOut: result.timedOut,
        command: "go test -count=1 -run ^TestAcceptance$ .", outputHash: sha256(result.stdout + result.stderr) };
    }
    const compiled = await execute(process.execPath, [tsc, "--project", "tsconfig.json"], { cwd: grader });
    if (compiled.code !== 0 || compiled.timedOut) return { passed: false, stage: "compile", exitCode: compiled.code, timedOut: compiled.timedOut,
      outputHash: sha256(compiled.stdout + compiled.stderr) };
    await writeFile(path.join(grader, "acceptance.cjs"), `const assert=require('node:assert/strict');\n${task.test}\n`);
    const result = await execute(process.execPath, ["acceptance.cjs"], { cwd: grader });
    return { passed: result.code === 0 && !result.timedOut, stage: "acceptance", exitCode: result.code, timedOut: result.timedOut,
      command: "tsc --project tsconfig.json && node acceptance.cjs", outputHash: sha256(result.stdout + result.stderr) };
  } finally { await rm(grader, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

async function sourceSnapshot(root) {
  const output = [];
  async function visit(relative) {
    const files = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const name = path.posix.join(relative === "." ? "" : relative, file.name);
      if (file.isSymbolicLink()) throw new Error(`Symlink in evaluated source: ${name}`);
      if (file.isDirectory() && ![".llmnav", ".serena", "node_modules", ".git", "out"].includes(file.name)) await visit(name);
      else if (file.isFile()) output.push({ path: name, hash: sha256(await readFile(path.join(root, name))) });
    }
  }
  await visit(".");
  return output;
}

async function preflightModel(options, workspaceParent) {
  const root = await mkdtemp(path.join(workspaceParent, "llmnav-model-preflight-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, ".llmnav"));
    await mkdir(path.join(root, ".serena/memories"), { recursive: true });
    await writeFile(path.join(root, "src/probe.ts"), "export function probeNavigation() { return 1; }\n");
    await writeFile(path.join(root, ".llmnav/config.json"), '{"repositoryId":"probe","sourceRoots":["src"]}\n');
    await writeFile(path.join(root, ".serena/project.yml"), "project_name: probe\nlanguages: [typescript]\n");
    await writeFile(path.join(root, ".serena/memories/evaluation.md"), "Disposable preflight. No onboarding required.\n");
    const withSerena = options.conditions.includes("serena");
    const args = modelArguments(root, options.beforeMode ? "llmnav-before" : "llmnav", { prompt: "Environment preflight." }, options);
    const extra = { command: options.uvx ?? "uvx", args: serenaArguments(root), required: true,
      enabled_tools: ["initial_instructions", "find_symbol"], startup_timeout_sec: 120, tool_timeout_sec: 100 };
    args.pop();
    if (withSerena) for (const [key, value] of Object.entries(extra)) args.push("-c", `mcp_servers.eval_serena.${key}=${JSON.stringify(value)}`);
    args.push("Environment preflight only. First call llmnav_discover for probeNavigation. " +
      (withSerena ? "Then call Serena find_symbol for probeNavigation (and initial_instructions if required). " : "") +
      "Create model-write-probe.txt containing exactly ready, without a newline. Use your file and shell tools as needed. " +
      "Do not change source, create memories or commits, inspect paths outside this workspace, or inspect credentials or environment variables. Stop after the file is written.");
    const result = await execute(options.codex ?? "codex", args, { cwd: root, timeoutMs: options.timeoutMs, env: options.env });
    const trace = summarizeTrace(result.stdout);
    const successful = tool => trace.tools.some(item => item.tool === tool && item.status === "completed" && !item.toolError);
    const writePassed = await readFile(path.join(root, "model-write-probe.txt"), "utf8").then(text => text === "ready", () => false);
    const outcome = { writePassed, llmnavPassed: successful("llmnav_discover"), serenaPassed: withSerena ? successful("find_symbol") : null,
      elapsedMs: result.elapsedMs, exitCode: result.code, timedOut: result.timedOut, trace };
    console.log(JSON.stringify({ preflight: outcome }));
    return outcome;
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

export function modelArguments(root, condition, task, options) {
  const args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--json",
    "-m", options.model, "-c", 'model_reasoning_effort="high"', "-c", 'approval_policy="never"',
    "-c", "memories.use_memories=false", "-c", "memories.generate_memories=false", "-C", root];
  if (process.platform === "win32") args.push("-c", 'windows.sandbox="unelevated"');
  if (condition !== "baseline") {
    const isLlmnav = condition.startsWith("llmnav");
    const command = isLlmnav ? process.execPath : options.uvx ?? "uvx";
    const serverArgs = isLlmnav ? [condition === "llmnav-before" ? options.beforeCli : cli, "mcp", "--root", root] : serenaArguments(root);
    const tools = isLlmnav ? ["llmnav_discover"] : ["initial_instructions", "check_onboarding_performed", "read_memory",
      "find_symbol", "get_symbols_overview", "find_referencing_symbols", "search_for_pattern"];
    for (const [key, value] of Object.entries({ command, args: serverArgs, enabled_tools: tools,
      required: true, startup_timeout_sec: 120, tool_timeout_sec: 100 })) args.push("-c", `mcp_servers.eval_nav.${key}=${JSON.stringify(value)}`);
  }
  const navigation = condition === "baseline" ? "Use only ordinary shell/file navigation (rg, directory listings, source reads). Do not invoke LLMNav, Serena or another semantic navigation CLI, even if ancestor repository instructions recommend it; this trial's navigation condition takes precedence."
    : condition.startsWith("llmnav") ? "Before reading source bodies or using broad text search, use the llmnav_discover MCP tool to find a candidate. Then use ordinary file/edit tools."
      : "Before reading source bodies or using broad text search, use Serena find_symbol or get_symbols_overview to find a candidate. Follow initial_instructions if required. Onboarding is already performed. Then use ordinary file/edit tools.";
  args.push(`Fix the following bug in this disposable production-source copy.\n${task.prompt}\n\n${navigation}\n\n` +
    "Make the smallest production-code change. Preserve public signatures. Do not create tests, memories, commits, or dependencies, and do not change config files. " +
    "Independent acceptance tests run after your turn. Do not inspect paths outside this workspace or tool installation directories. Do not inspect credentials or environment variables. Stop once the source fix is complete.");
  return args;
}

export async function runModelCoding(options) {
  const conditions = options.conditions ?? defaultConditions;
  assert.ok(conditions.length && new Set(conditions).size === conditions.length &&
    conditions.every(condition => [...defaultConditions, "llmnav-before"].includes(condition)), "Invalid evaluation conditions");
  assert.ok(!conditions.includes("llmnav-before") || typeof options.beforeCli === "string", "llmnav-before requires beforeCli");
  options = { ...options, conditions };
  const report = { schemaVersion: 1, packageVersion: PACKAGE_VERSION, measuredAt: new Date().toISOString(),
    model: { requested: options.model, reasoningEffort: "high", resolvedProviderModel: null, authentication: "existing Codex CLI login" },
    harnessHash: sha256(await readFile(fileURLToPath(import.meta.url), "utf8")),
    casesHash: sha256(await readFile(path.join(here, "coding-cases.js"), "utf8")), serenaVersion: SERENA_VERSION,
    environment: { node: process.version, platform: process.platform, filesystemCacheFlushed: false },
    methodology: { trialsPerTaskCondition: 1, conditions, conditionOrder: "rotate by task index", concurrency: 1,
      perRunTimeoutMs: options.timeoutMs, grading: "pristine-positive, mutant-negative, then hidden acceptance and source-scope checks",
      restrictions: "navigation instructions and read boundaries are prompt-enforced; not an adversarial isolation boundary",
      workspaceLocation: "ignored fixture directory inside the authorized repository", memoriesEnabled: false,
      windowsBackend: process.platform === "win32" ? "unelevated" : null },
    corpora: [], controls: [], rows: [], complete: false,
    limitations: ["Eight author-curated injected regressions in small real-source scopes, not discovered production bugs, blind holdouts, or representative maintenance work.",
      "Go standard-library familiarity, small/easy tasks, one trial, cache state, and condition-specific MCP instructions limit generalization.",
      "A successful edit does not prove the navigation tool caused success. Tool adherence is measured separately.",
      "CLI token counts include its system/tool prompt. Monetary cost, human card authoring, maintenance and resolved provider model are unmeasured.",
      "Only sanitized event metadata is retained; raw model reasoning, prompts and command output are not saved."] };
  report.engines = {};
  for (const [condition, executable] of [["llmnav", cli], ...(conditions.includes("llmnav-before") ? [["llmnav-before", options.beforeCli]] : [])]) {
    const engineRoot = path.resolve(path.dirname(executable), "..");
    report.engines[condition] = { version: JSON.parse(await readFile(path.join(engineRoot, "package.json"), "utf8")).version, hashes: {} };
    for (const file of ["src/mcp.js", "src/discovery.js", "src/agent-tools.js", "src/agent-protocol.js"]) {
      report.engines[condition].hashes[file] = sha256(await readFile(path.join(engineRoot, file), "utf8"));
    }
  }
  const prerequisites = [["codex", options.codex ?? "codex", ["--version"]], ["go", "go", ["version"]]];
  if (conditions.includes("serena")) prerequisites.push(["gopls", "gopls", ["version"]]);
  for (const [name, command, args] of prerequisites) {
    const result = await execute(command, args);
    assert.equal(result.code, 0, `Missing evaluation prerequisite: ${name}`);
    report.environment[name] = result.stdout.trim();
  }
  report.environment.typescript = JSON.parse(await readFile(path.join(here, "../node_modules/typescript/package.json"), "utf8")).version;
  const templates = [];
  try {
    for (const entry of entries) {
      const original = path.resolve(entry.language === "go" ? options.goRoot : options.typescriptRoot);
      const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-coding-template-"));
      const sources = await prepareCorpus(original, root, entry);
      templates.push({ entry, root, original, sources });
      report.corpora.push({ id: entry.id, corpusHash: digest(sources), files: sources.length, originalsUnchanged: null });
    }
    // Validate and freeze every oracle before paying for any model attempt.
    for (const task of codingCases) {
      const { entry, root, sources } = templates.find(item => item.entry.language === task.language);
      const text = sources.find(file => file.path === task.file)?.text;
      assert.ok(text, `Missing mutation target: ${task.id}`);
      const pristine = await grade(root, entry, task);
      assert.ok(pristine.passed, `Pristine oracle failed: ${task.id} ${JSON.stringify(pristine)}`);
      await writeFile(path.join(root, task.file), mutateSource(text, task));
      let mutant;
      try { mutant = await grade(root, entry, task); } finally { await writeFile(path.join(root, task.file), text); }
      assert.ok(!mutant.passed && !mutant.timedOut && mutant.stage !== "compile", `Mutant not behaviorally rejected: ${task.id}`);
      report.controls.push({ task: task.id, pristine, mutant });
      console.log(JSON.stringify({ control: task.id, pristine: pristine.passed, mutant: mutant.passed }));
    }
    await writeFile(options.output, stableStringify(report));
    if (options.controlsOnly) return report;
    const workspaceParent = options.workspaceParent ?? path.join(here, "../.llmnav/tmp");
    await mkdir(workspaceParent, { recursive: true });
    report.preflight = await preflightModel(options, workspaceParent);
    if (conditions.includes("llmnav-before")) report.beforePreflight = await preflightModel({ ...options, beforeMode: true }, workspaceParent);
    await writeFile(options.output, stableStringify(report));
    assert.ok(report.preflight.writePassed && report.preflight.llmnavPassed && (!conditions.includes("serena") || report.preflight.serenaPassed),
      "Model preflight failed; no coding attempts may be scored");
    assert.ok(!report.beforePreflight || report.beforePreflight.writePassed && report.beforePreflight.llmnavPassed,
      "Before-version preflight failed; no coding attempts may be scored");
    for (const [index, task] of codingCases.entries()) {
      const { entry, root: template, sources } = templates.find(item => item.entry.language === task.language);
      const order = [...conditions.slice(index % conditions.length), ...conditions.slice(0, index % conditions.length)];
      for (const condition of order) {
        const root = await mkdtemp(path.join(workspaceParent, "llmnav-coding-run-"));
        try {
          await prepareCorpus(template, root, entry);
          await mkdir(path.join(root, ".serena/memories"), { recursive: true });
          await writeFile(path.join(root, ".serena/memories/evaluation.md"), "Disposable production-source copy. No project setup is required.\n");
          await writeFile(path.join(root, task.file), mutateSource(sources.find(file => file.path === task.file).text, task));
          const before = await sourceSnapshot(root);
          const result = await execute(options.codex ?? "codex", modelArguments(root, condition, task, options),
            { cwd: root, timeoutMs: options.timeoutMs, env: options.env });
          const trace = summarizeTrace(result.stdout);
          const after = await sourceSnapshot(root);
          const all = new Map([...before, ...after].map(item => [item.path, null]));
          const changedFiles = [...all.keys()].filter(file => before.find(item => item.path === file)?.hash !== after.find(item => item.path === file)?.hash);
          const acceptance = await grade(root, entry, task);
          const scopePassed = changedFiles.length === 1 && changedFiles[0] === task.file;
          const navigationUsed = condition === "baseline" ? null : trace.tools.some(tool => tool.type === "mcp_tool_call" && tool.status === "completed" && !tool.toolError &&
            (condition.startsWith("llmnav") ? tool.tool === "llmnav_discover" : ["find_symbol", "get_symbols_overview"].includes(tool.tool)));
          const row = { task: task.id, language: task.language, condition, elapsedMs: result.elapsedMs,
            exitCode: result.code, timedOut: result.timedOut, trace, navigationUsed,
            conditionAdhered: condition === "baseline" ? !trace.tools.some(tool => tool.semanticCliMentioned) : navigationUsed,
            changedFiles, scopePassed, acceptance,
            success: acceptance.passed && scopePassed && trace.completed && result.code === 0 && !result.timedOut,
            stderrHash: sha256(result.stderr) };
          report.rows.push(row);
          await writeFile(options.output, stableStringify(report));
          console.log(JSON.stringify({ task: task.id, condition, success: row.success, navigationUsed, elapsedMs: row.elapsedMs,
            uncachedInputTokens: trace.uncachedInputTokens, toolCalls: trace.tools.length }));
        } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      }
    }
    report.complete = true;
    return report;
  } finally {
    for (const template of templates) {
      const unchanged = digest(await readOriginals(template.original, template.sources)) === digest(template.sources);
      report.corpora.find(item => item.id === template.entry.id).originalsUnchanged = unchanged;
      await rm(template.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      assert.ok(unchanged, "Original source changed during model evaluation");
    }
    await writeFile(options.output, stableStringify(report));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
  assert.ok(["--typescript-root", "--go-root", "--output"].every(name => args.includes(name)), "Supply corpus roots and --output");
  await runModelCoding({ typescriptRoot: option("--typescript-root"), goRoot: option("--go-root"), output: option("--output"),
    model: args.includes("--model") ? option("--model") : "gpt-6.1-sol", timeoutMs: 180000,
    conditions: args.includes("--conditions") ? option("--conditions").split(",") : undefined,
    beforeCli: args.includes("--before-cli") ? path.resolve(option("--before-cli")) : undefined,
    controlsOnly: args.includes("--controls-only") });
}
