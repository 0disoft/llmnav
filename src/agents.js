/* llmnav/1 module
id=llmnav.agent.install
role=Install one managed navigation protocol into instruction files used by major coding agents.
owns=agent instruction adapters|managed instruction blocks
excludes=postinstall mutation|agent execution
search=agent instructions|AGENTS.md integration|coding assistant setup
rel=workflow>llmnav.search.query
stability=architecture
*/

import path from "node:path";
import { assertNoSymlinkTraversal, atomicWrite, readText } from "./util.js";

const START = "<!-- llmnav:start -->";
const END = "<!-- llmnav:end -->";

export const AGENT_PROTOCOL = `## LLMNav code navigation

${START}
Before broad grep, directory scans, or opening many source files, run \`npm exec -- llmnav query "<task>" --top 5\`.

Resolve the selected semantic ID with \`npm exec -- llmnav show <id>\`. Use \`npm exec -- llmnav context <id> --depth 1 --budget 2500\` when related policy, workflow, fallback, migration, or test cards are needed.

When the host supports structured tools, load the provider-neutral definitions from \`npm exec -- llmnav tools --json\`. Keep the repository root bound by the host rather than accepting it from model-generated tool input.

Read generated cards and signatures before opening full symbol bodies. Treat paths, line numbers, signatures, imports, and hashes as generated data rather than source-of-truth annotations.

Keep an existing LLMNav ID when a symbol or file is renamed or moved. Change \`role\`, \`invariant\`, \`effect\`, \`risk\`, and semantic \`rel\` values only when behavior or contracts change.

Do not add hand-maintained \`calls\`, \`imports\`, \`references\`, \`implements\`, \`exports\`, or \`overrides\` relations. Do not put paths, line numbers, commit hashes, timestamps, callers, or current signatures in LLMNav source comments.

After initialization and whenever public entrypoints, commands, routes, schemas, migrations, or high fan-in modules change, run \`npm exec -- llmnav audit\`. Review high and medium candidates; never add cards automatically. Add a module card only after confirming a durable responsibility, then encode the accepted boundary in a path-specific \`coverageRules\` entry and add a representative retrieval query. When a reviewed candidate has no durable navigation responsibility, record its exact path and a concrete reason in \`audit.dispositions\`; never use a glob or broad directory suppression.

When deciding whether one specific file needs a card, run \`npm exec -- llmnav explain <file>\`. Use its coverage, score, and disposition evidence to guide review, but never turn its recommendation into automatic source annotation.

After semantic changes, run \`npm exec -- llmnav format\`, \`npm exec -- llmnav check\`, and \`npm exec -- llmnav generate\`. If no credible card is returned, run \`npm exec -- llmnav discover "<task>" --top 5\` for live file and declaration candidates. Read their source before adding a card. Use broad text search when discovery also has no credible candidate.
${END}`;

export async function installAgentInstructions(root, adapters = ["agents"]) {
  const planned = await planAgentInstructions(root, adapters);
  for (const item of planned) await atomicWrite(root, item.target, item.content);
  return planned.map(item => item.path);
}

/** Check every selected instruction target before project bootstrap writes anything. */
export async function validateAgentInstructions(root, adapters = ["agents"]) {
  await planAgentInstructions(root, adapters);
}

async function planAgentInstructions(root, adapters) {
  const selected = normalizeAgentAdapters(adapters);
  const planned = [];
  const markdown = {
    agents: ["AGENTS.md", "# Repository instructions"],
    claude: ["CLAUDE.md", "# Claude Code instructions"],
    copilot: [".github/copilot-instructions.md", "# GitHub Copilot instructions"],
  };
  for (const adapter of selected) {
    const [displayPath, title] = adapter === "cursor" ? [".cursor/rules/llmnav.mdc", null] : markdown[adapter];
    const target = path.join(root, displayPath);
    await assertNoSymlinkTraversal(root, target, displayPath);
    const existing = await readText(target, "");
    const content = adapter === "cursor"
      ? `---\ndescription: Use LLMNav before broad codebase exploration\nalwaysApply: true\n---\n\n${AGENT_PROTOCOL}\n`
      : renderMarkdown(existing, displayPath, title, AGENT_PROTOCOL);
    if (existing !== content) planned.push({ path: displayPath, target, content });
  }

  const canonicalPath = path.join(root, ".llmnav", "AGENT_INSTRUCTIONS.md");
  await assertNoSymlinkTraversal(root, canonicalPath, ".llmnav/AGENT_INSTRUCTIONS.md");
  const canonical = `# LLMNav agent protocol\n\n${AGENT_PROTOCOL}\n`;
  if ((await readText(canonicalPath, "")) !== canonical) {
    planned.push({ path: ".llmnav/AGENT_INSTRUCTIONS.md", target: canonicalPath, content: canonical });
  }
  return planned;
}

export function normalizeAgentAdapters(adapters) {
  const values = adapters
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set(["all", "none", "agents", "claude", "copilot", "cursor"]);
  const unknown = values.filter((value) => !allowed.has(value));
  if (unknown.length > 0) throw adapterUsageError(`Unknown agent adapter(s): ${[...new Set(unknown)].join(", ")}.`);
  if (values.includes("none")) {
    if (values.length > 1) throw adapterUsageError("Agent adapter none cannot be combined with other adapters.");
    return [];
  }
  if (values.includes("all")) return ["agents", "claude", "copilot", "cursor"];
  return [...new Set(values)];
}


function adapterUsageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function renderMarkdown(existing, displayPath, title, block) {
  let next;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw adapterUsageError(`${displayPath} contains an incomplete LLMNav managed block. Correct the markers and rerun initialization.`);
  }
  if (start >= 0 && (existing.indexOf(START, start + START.length) >= 0 || existing.indexOf(END, end + END.length) >= 0)) {
    throw adapterUsageError(`${displayPath} contains multiple LLMNav managed blocks. Keep one complete marker pair and rerun initialization.`);
  }
  if (start >= 0 && end >= start) {
    // Only the generated heading directly adjacent to the marker belongs to us.
    const before = existing.slice(0, start).replace(/(?:^|\r?\n)## LLMNav code navigation[ \t]*\r?\n[ \t\r\n]*$/u, "");
    const after = existing.slice(end + END.length).replace(/^\s+/u, "");
    next = `${before.trimEnd()}${before.trim() ? "\n\n" : ""}${block}\n${after ? `\n${after.trimStart()}` : ""}`;
  } else if (!existing.trim()) {
    next = `${title}\n\n${block}\n`;
  } else {
    next = `${existing.trimEnd()}\n\n${block}\n`;
  }
  return next;
}
