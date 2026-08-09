/* llmnav/1 module
id=llmnav.agent.install
role=Install one managed navigation protocol into instruction files used by major coding agents.
owns=agent instruction adapters|managed instruction blocks
excludes=postinstall mutation|agent execution
search=agent instructions|AGENTS.md integration|coding assistant setup
rel=workflow>llmnav.search.query
stability=architecture
*/

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkTraversal, atomicWrite, readText } from "./util.js";

const START = "<!-- llmnav:start -->";
const END = "<!-- llmnav:end -->";

export const AGENT_PROTOCOL = `## LLMNav code navigation

${START}
Before broad grep, directory scans, or opening many source files, run \`npm exec -- llmnav query "<task>" --top 5\`.

Resolve the selected semantic ID with \`npm exec -- llmnav show <id>\`. Use \`npm exec -- llmnav context <id> --depth 1 --budget 2500\` when related policy, workflow, fallback, migration, or test cards are needed.

Read generated cards and signatures before opening full symbol bodies. Treat paths, line numbers, signatures, imports, and hashes as generated data rather than source-of-truth annotations.

Keep an existing LLMNav ID when a symbol or file is renamed or moved. Change \`role\`, \`invariant\`, \`effect\`, \`risk\`, and semantic \`rel\` values only when behavior or contracts change.

Do not add hand-maintained \`calls\`, \`imports\`, \`references\`, \`implements\`, \`exports\`, or \`overrides\` relations. Do not put paths, line numbers, commit hashes, timestamps, callers, or current signatures in LLMNav source comments.

After semantic changes, run \`npm exec -- llmnav format\`, \`npm exec -- llmnav check\`, and \`npm exec -- llmnav generate\`. Use broad text search only when LLMNav returns no credible candidate.
${END}`;

export async function installAgentInstructions(root, adapters = ["agents"]) {
  const selected = normalizeAdapters(adapters);
  const changed = [];
  for (const adapter of selected) {
    if (adapter === "agents") {
      const target = path.join(root, "AGENTS.md");
      await assertNoSymlinkTraversal(root, target, "AGENTS.md");
      if (await upsertMarkdown(target, "# Repository instructions", AGENT_PROTOCOL)) {
        changed.push("AGENTS.md");
      }
    } else if (adapter === "claude") {
      const target = path.join(root, "CLAUDE.md");
      await assertNoSymlinkTraversal(root, target, "CLAUDE.md");
      if (await upsertMarkdown(target, "# Claude Code instructions", AGENT_PROTOCOL)) {
        changed.push("CLAUDE.md");
      }
    } else if (adapter === "copilot") {
      const target = path.join(root, ".github", "copilot-instructions.md");
      await assertNoSymlinkTraversal(root, target, ".github/copilot-instructions.md");
      if (await upsertMarkdown(target, "# GitHub Copilot instructions", AGENT_PROTOCOL)) {
        changed.push(".github/copilot-instructions.md");
      }
    } else if (adapter === "cursor") {
      const target = path.join(root, ".cursor", "rules", "llmnav.mdc");
      await assertNoSymlinkTraversal(root, target, ".cursor/rules/llmnav.mdc");
      const content = `---\ndescription: Use LLMNav before broad codebase exploration\nalwaysApply: true\n---\n\n${AGENT_PROTOCOL}\n`;
      const existing = await readText(target, "");
      if (existing !== content) {
        await atomicWrite(target, content);
        changed.push(".cursor/rules/llmnav.mdc");
      }
    }
  }

  const canonicalPath = path.join(root, ".llmnav", "AGENT_INSTRUCTIONS.md");
  await assertNoSymlinkTraversal(root, canonicalPath, ".llmnav/AGENT_INSTRUCTIONS.md");
  const canonical = `# LLMNav agent protocol\n\n${AGENT_PROTOCOL}\n`;
  if ((await readText(canonicalPath, "")) !== canonical) {
    await atomicWrite(canonicalPath, canonical);
    changed.push(".llmnav/AGENT_INSTRUCTIONS.md");
  }
  return changed;
}

function normalizeAdapters(adapters) {
  const values = adapters
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set(["all", "none", "agents", "claude", "copilot", "cursor"]);
  const unknown = values.filter((value) => !allowed.has(value));
  if (unknown.length > 0) throw adapterUsageError(`Unknown agent adapter(s): ${[...new Set(unknown)].join(", ")}.`);
  if (values.includes("all")) return ["agents", "claude", "copilot", "cursor"];
  if (values.includes("none")) {
    if (values.length > 1) throw adapterUsageError("Agent adapter none cannot be combined with other adapters.");
    return [];
  }
  return [...new Set(values)];
}


function adapterUsageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

async function upsertMarkdown(filePath, title, block) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readText(filePath, "");
  let next;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error(`${filePath} contains an incomplete LLMNav managed block.`);
  }
  if (start >= 0 && existing.indexOf(START, start + START.length) >= 0) {
    throw new Error(`${filePath} contains multiple LLMNav managed blocks.`);
  }
  if (start >= 0 && end >= start) {
    const before = existing.slice(0, Math.max(0, existing.lastIndexOf("## LLMNav code navigation", start)));
    const after = existing.slice(end + END.length).replace(/^\s+/u, "");
    next = `${before.trimEnd()}${before.trim() ? "\n\n" : ""}${block}\n${after ? `\n${after.trimStart()}` : ""}`;
  } else if (!existing.trim()) {
    next = `${title}\n\n${block}\n`;
  } else {
    next = `${existing.trimEnd()}\n\n${block}\n`;
  }
  if (next === existing) return false;
  await atomicWrite(filePath, next);
  return true;
}
