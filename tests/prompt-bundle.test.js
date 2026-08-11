import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_PROTOCOL } from "../src/agents.js";
import { getAgentToolDefinitions } from "../src/agent-tools.js";
import {
  buildPromptPrefixBundle,
  isCompatiblePromptPrefixBundle,
  loadPromptPrefixBundle,
  renderPromptPrefixBundle,
} from "../src/prompt-bundle.js";
import { initializeProject } from "../src/initializer.js";

test("builds deterministic explicit prompt cache partitions", () => {
  const input = {
    repositoryId: "fixture",
    toolDefinitions: getAgentToolDefinitions(),
    agentProtocol: AGENT_PROTOCOL,
    repositoryCore: "repository core\n",
    modules: [
      { id: "zeta", content: "zeta module\n" },
      { id: "alpha", content: "alpha module\n" },
    ],
  };
  const bundle = buildPromptPrefixBundle(input);
  assert.equal(isCompatiblePromptPrefixBundle(bundle, "fixture"), true);
  assert.deepEqual(bundle.partitions.map((item) => item.id), [
    "package:tool-definitions",
    "package:agent-protocol",
    "repository:core",
    "module:alpha",
    "module:zeta",
  ]);
  assert.deepEqual(bundle.assembly.basePartitionIds, [
    "package:tool-definitions",
    "package:agent-protocol",
    "repository:core",
  ]);
  assert.equal(renderPromptPrefixBundle(buildPromptPrefixBundle(input)), renderPromptPrefixBundle(bundle));

  const changedModule = buildPromptPrefixBundle({
    ...input,
    modules: [{ id: "alpha", content: "changed module\n" }],
  });
  assert.deepEqual(
    changedModule.partitions.slice(0, 3).map((item) => item.contentHash),
    bundle.partitions.slice(0, 3).map((item) => item.contentHash),
  );
  const corrupted = structuredClone(bundle);
  corrupted.partitions[0].content = "corrupted";
  assert.equal(isCompatiblePromptPrefixBundle(corrupted), false);
});

test("loads only manifest-matched generated prompt bundles", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-prompt-bundle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"prompt-bundle-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "fixture.ts"),
    `/* llmnav/1 module
id=fixture.core
role=Own the fixture repository behavior.
owns=fixture behavior
excludes=external systems
search=fixture core|fixture behavior
stability=architecture
*/
export const fixture = true;
`,
  );
  assert.equal((await initializeProject(root, { agents: ["none"] })).ok, true);

  const bundle = await loadPromptPrefixBundle(root);
  assert.equal(bundle.repositoryId, "prompt-bundle-fixture");
  assert.ok(bundle.partitions.some((item) => item.id === "module:fixture.core"));

  const bundlePath = path.join(root, ".llmnav", "cache", "prompt-prefix.json");
  const content = await readFile(bundlePath, "utf8");
  await writeFile(bundlePath, `${content.trimEnd()}  \n`);
  await assert.rejects(() => loadPromptPrefixBundle(root), /does not match manifest/u);
});

test("rejects a prompt cache junction that escapes the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-prompt-link-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "llmnav-prompt-link-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"prompt-link-fixture"}\n');
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  await writeFile(path.join(root, ".llmnav", "config.json"), JSON.stringify({
    repositoryId: "prompt-link-fixture",
    generation: { cacheDirectory: ".llmnav/cache" },
  }));
  await symlink(external, path.join(root, ".llmnav", "cache"), "junction");
  await writeFile(path.join(external, "prompt-prefix.json"), "external secret\n");

  await assert.rejects(() => loadPromptPrefixBundle(root), /traverses symbolic link/u);
});
