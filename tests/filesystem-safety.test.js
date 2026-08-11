import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistStatHints } from "../src/incremental.js";
import { initializeProject } from "../src/initializer.js";

test("initialization rejects a schema directory junction outside the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-init-link-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "llmnav-init-link-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"init-link-fixture"}\n');
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  await symlink(external, path.join(root, ".llmnav", "schema"), "junction");

  await assert.rejects(() => initializeProject(root, { agents: ["none"] }), /traverses symbolic link/u);
  assert.deepEqual(await readdir(external), []);
});

test("stat hints reject a state directory junction outside the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-state-link-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "llmnav-state-link-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  await symlink(external, path.join(root, ".llmnav", "state"), "junction");

  await assert.rejects(
    () => persistStatHints(root, path.join(root, ".llmnav", "state", "stat-hints.json"), { schemaVersion: 1 }),
    /traverses symbolic link/u,
  );
  assert.deepEqual(await readdir(external), []);
});
