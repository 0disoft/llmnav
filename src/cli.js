/* llmnav/1 module
id=llmnav.cli.dispatch
role=Expose initialization, validation, generation, search, evaluation, and diagnostics through one CLI.
owns=command dispatch|terminal output|exit codes
excludes=semantic rule definitions|index persistence format
search=llmnav cli|command line|automation interface
rel=workflow>llmnav.project.initialize
rel=workflow>llmnav.rules.validate
rel=workflow>llmnav.search.query
rel=workflow>llmnav.eval.measure
stability=architecture
*/

import path from "node:path";
import { findProjectRoot } from "./files.js";
import { initializeProject } from "./initializer.js";
import { scanProject } from "./project.js";
import { countDiagnostics, validateProject } from "./validator.js";
import { formatProject } from "./formatter.js";
import { generateProject, renderCompactCard } from "./generator.js";
import { buildContext, queryProject, showProjectCard } from "./search.js";
import { evaluateProject } from "./evaluation.js";
import { doctorProject } from "./doctor.js";
import {
  EFFECT_KINDS,
  KEY_ORDER,
  PACKAGE_VERSION,
  RELATION_KINDS,
  RISK_KINDS,
  SPEC_VERSION,
  STABILITIES,
} from "./spec.js";
import { parseInteger } from "./util.js";
import { diagnosticsToSarif } from "./sarif.js";
import { loadGraphInputs } from "./graph-input.js";
import { renderGraphNode } from "./graph.js";
import { getAgentToolDefinitions } from "./agent-protocol.js";

const VALUE_OPTIONS = new Set(["--root", "--format", "--top", "--depth", "--budget", "--max-edges", "--agents", "--file"]);

const COMMAND_OPTIONS = Object.freeze({
  init: new Set(["--agents", "--package-scripts", "--force", "--root", "--json"]),
  check: new Set(["--format", "--root", "--json"]),
  format: new Set(["--check", "--root", "--json"]),
  generate: new Set(["--check", "--verify", "--root", "--json"]),
  index: new Set(["--check", "--verify", "--root", "--json"]),
  query: new Set(["--top", "--root", "--json"]),
  show: new Set(["--root", "--json"]),
  context: new Set(["--depth", "--budget", "--max-edges", "--root", "--json"]),
  eval: new Set(["--file", "--top", "--root", "--json"]),
  doctor: new Set(["--root", "--json"]),
  spec: new Set(["--root", "--json"]),
  tools: new Set(["--json"]),
  help: new Set(["--root", "--json"]),
});

export async function runCli(argv) {
  if (argv.length === 0 || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printHelp();
    return 0;
  }
  if (hasFlag(argv, "--version") || hasFlag(argv, "-v") || argv[0] === "version") {
    console.log(PACKAGE_VERSION);
    return 0;
  }

  const command = argv[0];
  const args = argv.slice(1);
  validateOptions(command, args);
  const json = hasFlag(args, "--json");
  if (command === "tools") return runTools(json);
  const rootOption = getOption(args, "--root");
  const root = rootOption ? path.resolve(rootOption) : await findProjectRoot(process.cwd());

  switch (command) {
    case "init":
      return runInit(root, args, json);
    case "check":
      return runCheck(root, args, json);
    case "format":
      return runFormat(root, args, json);
    case "generate":
    case "index":
      return runGenerate(root, args, json);
    case "query":
      return runQuery(root, args, json);
    case "show":
      return runShow(root, args, json);
    case "context":
      return runContext(root, args, json);
    case "eval":
      return runEval(root, args, json);
    case "doctor":
      return runDoctor(root, json);
    case "spec":
      return runSpec(json);
    case "help":
      printHelp();
      return 0;
    default:
      console.error(`Unknown command ${JSON.stringify(command)}. Run llmnav --help.`);
      return 2;
  }
}

async function runInit(root, args, json) {
  const agents = (getOption(args, "--agents") ?? "agents").split(",");
  const result = await initializeProject(root, {
    force: hasFlag(args, "--force"),
    packageScripts: hasFlag(args, "--package-scripts"),
    agents,
  });
  if (json) {
    console.log(JSON.stringify({ ok: result.ok, root, changed: result.changed }, null, 2));
  } else {
    console.log(`Initialized LLMNav in ${root}`);
    if (result.changed.length === 0) console.log("No files changed.");
    for (const file of result.changed) console.log(`  wrote ${file}`);
    if (!result.ok) printDiagnostics(result.generated.diagnostics, "text");
  }
  return result.ok ? 0 : 1;
}

async function runCheck(root, args, json) {
  const format = json ? "json" : getOption(args, "--format") ?? "text";
  if (!["text", "json", "github", "sarif"].includes(format)) throw usageError(`Unknown diagnostic format ${JSON.stringify(format)}.`);
  const paths = getPositionals(args);
  const project = await scanProject(root, { paths });
  const graphInputs = await loadGraphInputs(root, project.config);
  const diagnostics = [...validateProject(project), ...graphInputs.diagnostics].sort(compareCliDiagnostics);
  const counts = countDiagnostics(diagnostics);
  const ok = counts.error === 0;
  if (format === "json") {
    console.log(JSON.stringify({ ok, counts, diagnostics }, null, 2));
  } else if (format === "sarif") {
    console.log(JSON.stringify(diagnosticsToSarif(diagnostics), null, 2));
  } else {
    printDiagnostics(diagnostics, format);
    if (format === "text") {
      console.log(`${counts.error} error(s), ${counts.warning} warning(s), ${project.records.length} card(s)`);
    }
  }
  return ok ? 0 : 1;
}

async function runFormat(root, args, json) {
  const check = hasFlag(args, "--check");
  const result = await formatProject(root, { check, paths: getPositionals(args) });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const error of result.errors) console.error(`${error.file}:${error.line}:1 error LNV010 ${error.message}`);
    if (result.changedFiles.length === 0 && result.errors.length === 0) {
      console.log("All LLMNav blocks are canonical.");
    } else {
      for (const file of result.changedFiles) console.log(`${check ? "would format" : "formatted"} ${file}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function runGenerate(root, args, json) {
  const check = hasFlag(args, "--check") || hasFlag(args, "--verify");
  const result = await generateProject(root, { check });
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          changedFiles: result.changedFiles,
          changedCards: result.changedCards,
          affectedBoundaries: result.affectedBoundaries,
          affectedCatalogs: result.affectedCatalogs,
          incremental: result.incremental,
          transaction: result.transaction,
          diagnostics: result.diagnostics,
        },
        null,
        2,
      ),
    );
  } else {
    if (result.diagnostics.length > 0) printDiagnostics(result.diagnostics, "text");
    if (result.changedFiles.length === 0 && result.ok) {
      console.log(check ? "Generated LLMNav files are current." : "Generated LLMNav index.");
    } else {
      for (const file of result.changedFiles) console.log(`${check ? "stale" : "generated"} ${file}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function runQuery(root, args, json) {
  const query = getPositionals(args).join(" ").trim();
  if (!query) {
    console.error("query requires search text.");
    return 2;
  }
  const top = parseCliIntegerOption(args, "--top", 5);
  const results = await queryProject(root, query, { top });
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else if (results.length === 0) {
    console.log("No credible LLMNav candidates found.");
  } else {
    for (const [index, result] of results.entries()) {
      const symbol = result.location?.symbol ? `#${result.location.symbol}` : "";
      const line = result.location?.declarationLine ?? result.location?.startLine ?? 1;
      console.log(`${index + 1}. @${result.id} score=${result.score}`);
      console.log(`   ${result.role}`);
      console.log(`   ${result.location?.path ?? "unknown"}${symbol}:${line}`);
      console.log(`   why ${result.reasons.join(", ")}`);
    }
  }
  return 0;
}

async function runShow(root, args, json) {
  const id = getPositionals(args)[0];
  if (!id) {
    console.error("show requires a semantic ID.");
    return 2;
  }
  const result = await showProjectCard(root, id);
  if (!result.card && !result.node) {
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.error(`Unknown or inactive semantic ID ${id}.`);
    return 1;
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    const resolvedId = result.card?.id ?? result.node?.key;
    if (result.resolvedFrom) console.log(`resolved ${id} -> ${resolvedId}\n`);
    console.log(result.card ? renderCompactCard(result.card) : renderGraphNode(result.node));
  }
  return 0;
}

async function runContext(root, args, json) {
  const id = getPositionals(args)[0];
  if (!id) {
    console.error("context requires a semantic ID.");
    return 2;
  }
  const result = await buildContext(root, id, {
    depth: parseCliIntegerOption(args, "--depth", 1),
    budget: parseCliIntegerOption(args, "--budget", 2500),
    maxEdges: parseCliIntegerOption(args, "--max-edges", 24),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.text);
  return 0;
}

async function runEval(root, args, json) {
  const result = await evaluateProject(root, {
    top: parseCliIntegerOption(args, "--top", 5),
    file: getOption(args, "--file"),
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const error of result.errors) console.error(error);
    for (const item of result.cases.filter((testCase) => !testCase.passAt5)) {
      console.error(`miss ${JSON.stringify(item.query)} expected=${item.expected.join(",")} actual=${item.actual.join(",")}`);
    }
    console.log(`cases ${result.metrics.total}`);
    console.log(`recall@1 ${(result.metrics.recallAt1 * 100).toFixed(1)}%`);
    console.log(`recall@5 ${(result.metrics.recallAt5 * 100).toFixed(1)}%`);
    console.log(`MRR ${result.metrics.meanReciprocalRank.toFixed(3)}`);
  }
  return result.ok ? 0 : 1;
}

async function runDoctor(root, json) {
  const result = await doctorProject(root);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const check of result.checks) console.log(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}`);
  }
  return result.ok ? 0 : 1;
}

function runSpec(json) {
  const spec = {
    specVersion: SPEC_VERSION,
    keyOrder: KEY_ORDER,
    stabilities: STABILITIES,
    effects: EFFECT_KINDS,
    risks: RISK_KINDS,
    relations: RELATION_KINDS,
  };
  if (json) console.log(JSON.stringify(spec, null, 2));
  else {
    console.log(`LLMNav/${SPEC_VERSION}`);
    console.log(`keys ${KEY_ORDER.join(" ")}`);
    console.log(`stability ${STABILITIES.join(" ")}`);
    console.log(`effects ${EFFECT_KINDS.join(" ")}`);
    console.log(`risks ${RISK_KINDS.join(" ")}`);
    console.log(`relations ${RELATION_KINDS.join(" ")}`);
  }
  return 0;
}

function runTools(json) {
  const definitions = getAgentToolDefinitions();
  if (json) console.log(JSON.stringify({ schemaVersion: 1, tools: definitions }, null, 2));
  else {
    for (const definition of definitions) console.log(`${definition.name}\t${definition.description}`);
  }
  return 0;
}

function printDiagnostics(diagnostics, format) {
  for (const item of diagnostics) {
    if (format === "github") {
      const command = item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "notice";
      console.log(
        `::${command} file=${escapeWorkflow(item.file)},line=${item.line},col=${item.column},title=${item.code}::${escapeWorkflow(item.message)}`,
      );
    } else {
      console.log(`${item.file}:${item.line}:${item.column} ${item.severity} ${item.code} ${item.message}`);
    }
  }
}

function compareCliDiagnostics(left, right) {
  return left.file.localeCompare(right.file, "en") || left.line - right.line || left.column - right.column ||
    left.code.localeCompare(right.code, "en") || left.message.localeCompare(right.message, "en");
}



function parseCliIntegerOption(args, name, fallback) {
  const value = getOption(args, name);
  if (value === undefined) return fallback;
  if (!/^-?\d+$/u.test(value)) throw usageError(`Option ${name} requires an integer.`);
  return parseInteger(value, fallback);
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function validateOptions(command, args) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) return;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;
    if (!argument.startsWith("--")) continue;
    const separator = argument.indexOf("=");
    const name = separator >= 0 ? argument.slice(0, separator) : argument;
    if (!allowed.has(name)) throw usageError(`Unknown option ${name} for command ${command}.`);
    if (VALUE_OPTIONS.has(name)) {
      const inlineValue = separator >= 0 ? argument.slice(separator + 1) : null;
      if (inlineValue !== null) {
        if (!inlineValue) throw usageError(`Option ${name} requires a value.`);
      } else {
        const next = args[index + 1];
        if (next === undefined || next.startsWith("--")) throw usageError(`Option ${name} requires a value.`);
        index += 1;
      }
    } else if (separator >= 0) {
      throw usageError(`Flag ${name} does not accept a value.`);
    }
  }
}

function getPositionals(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      values.push(...args.slice(index + 1));
      break;
    }
    if (argument.startsWith("--") || argument === "-h" || argument === "-v") {
      const name = argument.split("=", 1)[0];
      if (!argument.includes("=") && VALUE_OPTIONS.has(name)) index += 1;
      continue;
    }
    values.push(argument);
  }
  return values;
}

function getOption(args, name) {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  const prefix = `${name}=`;
  const inline = args.find((argument) => argument.startsWith(prefix));
  return inline?.slice(prefix.length);
}

function hasFlag(args, name) {
  return args.includes(name);
}

function escapeWorkflow(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A").replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function printHelp() {
  console.log(`llmnav ${PACKAGE_VERSION}

Deterministic semantic navigation for LLM coding agents.

Usage
  llmnav init [--agents all|agents,claude,copilot,cursor] [--package-scripts]
  llmnav check [paths...] [--format text|json|github|sarif]
  llmnav format [paths...] [--check]
  llmnav generate [--check]
  llmnav query "<task>" [--top 5]
  llmnav show <semantic-id>
  llmnav context <semantic-id> [--depth 1] [--budget 2500] [--max-edges 24]
  llmnav eval [--file path] [--top 5]
  llmnav doctor
  llmnav spec
  llmnav tools [--json]

Global options
  --root <path>    Project root
  --json           Machine-readable output
  --help           Show help
  --version        Show version`);
}
