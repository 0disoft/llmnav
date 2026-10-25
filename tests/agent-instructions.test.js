import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_PROTOCOL, installAgentInstructions } from "../src/agents.js";
import { initializeProject } from "../src/initializer.js";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-agent-preserve-"));
  context.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("llmnav-agent-preserve-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("every installed adapter permits targeted ordinary navigation and avoids redundant reads", async context => {
  const root = await fixture(context);
  await installAgentInstructions(root, ["all"]);
  for (const file of ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", ".cursor/rules/llmnav.mdc", ".llmnav/AGENT_INSTRUCTIONS.md"]) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.ok(text.includes(AGENT_PROTOCOL));
    assert.ok(text.includes("Skip semantic navigation"));
    assert.ok(text.includes("only for missing contract detail"));
    assert.ok(text.includes("Reuse sufficient excerpts"));
  }
});

for (const heading of ["", "## Team navigation\n\n", "## LLMNav code navigation\n\nKeep this independent rule.\n\n"]) {
  test(`managed instruction updates preserve the prefix with heading ${JSON.stringify(heading)}`, async (context) => {
    const root = await fixture(context);
    const prefix = "# Team instructions\n\nDo not publish without approval.\n\n" + heading;
    const suffix = "## More team rules\n\nKeep credentials out of logs.\n";
    const target = path.join(root, "AGENTS.md");
    await writeFile(target, prefix + "<!-- llmnav:start -->\nOld protocol.\n<!-- llmnav:end -->\n\n" + suffix);
    await installAgentInstructions(root, ["agents"]);
    const result = await readFile(target, "utf8");
    assert.ok(result.startsWith(prefix), "Instructions before the owned block were removed.");
    assert.ok(result.endsWith(suffix), "Instructions after the owned block were removed.");
    assert.ok(!result.includes("Old protocol."));
    assert.equal(result.split("<!-- llmnav:start -->").length, 2);
    assert.deepEqual(await installAgentInstructions(root, ["agents"]), []);
    assert.equal(await readFile(target, "utf8"), result);
  });
}

test("the adjacent generated heading is refreshed without duplicating it or changing outside rules", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, "CLAUDE.md");
  await writeFile(target, "# Team\r\n\r\nUse checked commands.\r\n\r\n## LLMNav code navigation\r\n\r\n<!-- llmnav:start -->\r\nOld protocol.\r\n<!-- llmnav:end -->\r\n\r\nKeep this tail.\r\n");
  await installAgentInstructions(root, ["claude"]);
  const result = await readFile(target, "utf8");
  assert.ok(result.startsWith("# Team\r\n\r\nUse checked commands."));
  assert.ok(result.endsWith("Keep this tail.\r\n"));
  assert.equal(result.split("## LLMNav code navigation").length, 2);
  assert.deepEqual(await installAgentInstructions(root, ["claude"]), []);
});

test("invalid later adapters cannot partially update earlier instructions and can recover after correction", async (context) => {
  const root = await fixture(context);
  const first = "# Team instructions\nDo not publish.\n";
  const invalid = "# Claude instructions\n<!-- llmnav:start -->\n";
  await writeFile(path.join(root, "AGENTS.md"), first);
  await writeFile(path.join(root, "CLAUDE.md"), invalid);
  await assert.rejects(() => installAgentInstructions(root, ["all"]), /incomplete LLMNav managed block/u);
  assert.equal(await readFile(path.join(root, "AGENTS.md"), "utf8"), first);
  assert.equal(await readFile(path.join(root, "CLAUDE.md"), "utf8"), invalid);
  assert.deepEqual((await readdir(root)).sort(), ["AGENTS.md", "CLAUDE.md"]);
  await writeFile(path.join(root, "CLAUDE.md"), "# Claude instructions\n");
  await installAgentInstructions(root, ["all"]);
  assert.ok((await readFile(path.join(root, "AGENTS.md"), "utf8")).startsWith(first));
});

test("bootstrap rejects broken selected instruction blocks before writing configuration or package scripts", async (context) => {
  const root = await fixture(context);
  const manifest = '{"name":"instruction-recovery"}\n';
  const first = "# Team instructions\nDo not publish.\n";
  const invalid = "<!-- llmnav:start -->\n";
  await writeFile(path.join(root, "package.json"), manifest);
  await writeFile(path.join(root, "AGENTS.md"), first);
  await writeFile(path.join(root, "CLAUDE.md"), invalid);
  await assert.rejects(() => initializeProject(root, { agents: ["all"], packageScripts: true }), /incomplete LLMNav managed block/u);
  assert.equal(await readFile(path.join(root, "AGENTS.md"), "utf8"), first);
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), manifest);
  assert.deepEqual((await readdir(root)).sort(), ["AGENTS.md", "CLAUDE.md", "package.json"]);
  await writeFile(path.join(root, "CLAUDE.md"), "# Claude instructions\n");
  assert.equal((await initializeProject(root, { agents: ["all"], packageScripts: true })).ok, true);
});

test("forced bootstrap with broken instructions preserves existing semantic state and configuration", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, "package.json"), '{"name":"instruction-existing"}\n');
  assert.equal((await initializeProject(root, { agents: ["none"] })).ok, true);
  const configPath = path.join(root, ".llmnav/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.repositoryId = "keep-existing-identity";
  await writeFile(configPath, JSON.stringify(config) + "\n");
  const files = [".llmnav/config.json", ".llmnav/ids.jsonl", ".llmnav/order.lock", ".llmnav/cache/index.json", "package.json"];
  const before = await Promise.all(files.map(file => readFile(path.join(root, file), "utf8")));
  await writeFile(path.join(root, "CLAUDE.md"), "<!-- llmnav:start -->\n");
  await assert.rejects(() => initializeProject(root, { agents: ["all"], force: true, packageScripts: true }), /incomplete LLMNav managed block/u);
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(root, file), "utf8"))), before);
  assert.equal((await readdir(root)).includes("AGENTS.md"), false);
});

test("duplicate closing markers are rejected without replacing instructions", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, "AGENTS.md");
  const text = "# Team instructions\n<!-- llmnav:start -->\nOld protocol.\n<!-- llmnav:end -->\nKeep these rules.\n<!-- llmnav:end -->\n";
  await writeFile(target, text);
  await assert.rejects(() => installAgentInstructions(root, ["agents"]), /multiple LLMNav managed blocks/u);
  assert.equal(await readFile(target, "utf8"), text);
});
