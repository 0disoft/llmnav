import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLlmnavHost } from "../examples/provider-neutral-host.mjs";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { loadPromptPrefixBundle } from "../src/prompt-bundle.js";
import { queryProject } from "../src/search.js";

test("keeps the packaged host on one snapshot during overlapping generation", { timeout: 30000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-neutral-host-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"neutral-host-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "auth.ts"),
    `/* llmnav/1 module
id=auth.session
role=Own refresh-token rotation and replay response.
owns=refresh-token rotation
excludes=access-token signing
search=refresh token|session rotation|token replay
stability=architecture
*/
export const authSession = true;
`,
  );
  assert.equal((await initializeProject(root, { agents: ["none"] })).ok, true);

  const host = await createLlmnavHost(root);
  assert.deepEqual(host.toolDefinitions.map((item) => item.name), [
    "llmnav_query",
    "llmnav_show",
    "llmnav_context",
    "llmnav_check",
    "llmnav_explain",
  ]);
  assert.deepEqual(host.basePromptPartitions.map((item) => item.id), [
    "package:tool-definitions",
    "package:agent-protocol",
    "repository:core",
  ]);
  assert.equal(host.selectPromptPartitions(["auth.session"]).at(-1).id, "module:auth.session");
  assert.throws(() => host.selectPromptPartitions(["missing.module"]), /Unknown prompt module/u);
  const initialGenerationHash = host.generationHash;
  assert.match(initialGenerationHash, /^[0-9a-f]{64}$/u);

  const result = await host.execute({ name: "llmnav_query", input: { task: "replayed refresh token" } });
  assert.equal(result.ok, true);
  assert.equal(result.data[0].id, "auth.session");

  await writeFile(
    path.join(root, "src", "quota.ts"),
    `/* llmnav/1 symbol\nid=generation.quota.reserve\nrole=Reserve one generation quota before remote execution.\nsearch=quota reservation|generation capacity\nstability=contract\n*/\nexport function reserveQuota() {}\n`,
  );
  const moved = Promise.withResolvers();
  const releaseWriter = Promise.withResolvers();
  const generation = generateProject(root, {
    onTransactionPhase: async (phase) => {
      if (phase === "after-cache-moved") {
        moved.resolve();
        await releaseWriter.promise;
      }
    },
  });
  await moved.promise;
  const readers = Promise.allSettled([
    loadPromptPrefixBundle(root),
    queryProject(root, "generation capacity"),
    host.refresh(),
  ]);
  let readersSettled = false;
  readers.then(() => { readersSettled = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(readersSettled, false);
    const stale = await host.execute({ name: "llmnav_query", input: { task: "generation capacity" } });
    assert.deepEqual(stale.data, []);
    assert.equal(host.generationHash, initialGenerationHash);
    assert.throws(() => host.selectPromptPartitions(["generation.quota"]), /Unknown prompt module/u);
  } finally {
    releaseWriter.resolve();
  }
  assert.equal((await generation).ok, true);
  const [bundleRead, directRead, refreshOutcome] = await readers;
  for (const outcome of [bundleRead, directRead, refreshOutcome]) {
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message);
  }
  assert.ok(bundleRead.value.partitions.some((item) => item.id === "module:generation.quota"));
  assert.equal(directRead.value[0].id, "generation.quota.reserve");
  assert.notEqual(host.generationHash, initialGenerationHash);
  assert.equal(host.selectPromptPartitions(["generation.quota"]).at(-1).id, "module:generation.quota");
  const refreshed = await host.execute({ name: "llmnav_query", input: { task: "generation capacity" } });
  assert.equal(refreshed.data[0].id, "generation.quota.reserve");
});
