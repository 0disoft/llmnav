import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installAgentInstructions } from "../src/agents.js";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-agent-preserve-"));
  context.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("llmnav-agent-preserve-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

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
