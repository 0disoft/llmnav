import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLlmnavHost } from "../examples/provider-neutral-host.mjs";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";

test("runs the packaged provider-neutral host example", async (context) => {
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

  const result = await host.execute({ name: "llmnav_query", input: { task: "replayed refresh token" } });
  assert.equal(result.ok, true);
  assert.equal(result.data[0].id, "auth.session");

  await writeFile(
    path.join(root, "src", "quota.ts"),
    `/* llmnav/1 symbol\nid=generation.quota.reserve\nrole=Reserve one generation quota before remote execution.\nsearch=quota reservation|generation capacity\nstability=contract\n*/\nexport function reserveQuota() {}\n`,
  );
  assert.equal((await generateProject(root)).ok, true);
  const stale = await host.execute({ name: "llmnav_query", input: { task: "generation capacity" } });
  assert.deepEqual(stale.data, []);
  await host.refresh();
  const refreshed = await host.execute({ name: "llmnav_query", input: { task: "generation capacity" } });
  assert.equal(refreshed.data[0].id, "generation.quota.reserve");
});
