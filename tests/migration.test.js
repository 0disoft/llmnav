import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { initializeProject } from "../src/initializer.js";
import { migrateProject } from "../src/migration.js";
import { SOURCE_INDEXER_VERSION } from "../src/incremental.js";

test("migration check reports incompatible generated formats without writing", async (context) => {
  const root = await createProject(context, "check");
  const statePath = path.join(root, ".llmnav", "cache", "file-state.json");
  const stale = JSON.parse(await readFile(statePath, "utf8"));
  stale.indexerVersion = SOURCE_INDEXER_VERSION - 1;
  const staleText = `${JSON.stringify(stale, null, 2)}\n`;
  await writeFile(statePath, staleText);

  const result = await migrateProject(root);

  assert.equal(result.ok, false);
  assert.equal(result.mode, "check");
  assert.equal(result.required, true);
  assert.equal(result.applied, false);
  assert.match(result.changedFiles.join("\n"), /file-state\.json/u);
  assert.equal(result.formats.find((item) => item.id === "file-state")?.status, "incompatible");
  assert.equal(await readFile(statePath, "utf8"), staleText);
});

test("migration write replaces the complete generated cache transactionally and is idempotent", async (context) => {
  const root = await createProject(context, "write");
  const statePath = path.join(root, ".llmnav", "cache", "file-state.json");
  const stale = JSON.parse(await readFile(statePath, "utf8"));
  stale.indexerVersion = SOURCE_INDEXER_VERSION - 1;
  await writeFile(statePath, `${JSON.stringify(stale, null, 2)}\n`);

  const migrated = await migrateProject(root, { write: true });

  assert.equal(migrated.ok, true);
  assert.equal(migrated.required, true);
  assert.equal(migrated.applied, true);
  assert.equal(migrated.transaction.committed, true);
  assert.ok(migrated.formats.every((item) => item.status === "current"));
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).indexerVersion, SOURCE_INDEXER_VERSION);

  const repeated = await migrateProject(root, { write: true });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.required, false);
  assert.equal(repeated.applied, false);
  assert.deepEqual(repeated.changedFiles, []);
});

test("migration write preserves the previous cache when source validation fails", async (context) => {
  const root = await createProject(context, "blocked");
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const previousIndex = await readFile(indexPath, "utf8");
  await writeFile(
    path.join(root, "source.js"),
    "/* llmnav/1 symbol\nid=blocked.change\nrole=Handle data.\nsearch=data|service\nstability=contract\n*/\nexport function changed() {}\n",
  );

  const result = await migrateProject(root, { write: true });

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.ok(result.diagnostics.some((item) => item.severity === "error"));
  assert.equal(await readFile(indexPath, "utf8"), previousIndex);
});

test("migration write rolls back when the generated-cache transaction fails", async (context) => {
  const root = await createProject(context, "rollback");
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const previousIndex = await readFile(indexPath, "utf8");
  await writeFile(
    path.join(root, "source.js"),
    "/* llmnav/1 symbol\nid=rollback.source\nrole=Preserve the previous cache when migration commit fails.\nsearch=migration rollback|cache recovery\nstability=contract\n*/\nexport function rollbackSource() {}\n",
  );

  await assert.rejects(
    () => migrateProject(root, { write: true, failpoint: "throw:after-cache-moved" }),
    /Injected generation failure/u,
  );
  assert.equal(await readFile(indexPath, "utf8"), previousIndex);
});

test("migration CLI rejects conflicting modes", async () => {
  await assert.rejects(
    () => runCli(["migrate", "--check", "--write"]),
    /either --check or --write/u,
  );
});

test("migration inspection rejects a generated artifact symlink outside the repository", async (context) => {
  const root = await createProject(context, "symlink");
  const external = await mkdtemp(path.join(os.tmpdir(), "llmnav-migrate-external-"));
  context.after(() => rm(external, { recursive: true, force: true }));
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const externalIndex = path.join(external, "index.json");
  await rename(indexPath, externalIndex);
  await symlink(externalIndex, indexPath, "file");

  await assert.rejects(() => migrateProject(root), /traverses symbolic link/u);
});

async function createProject(context, suffix) {
  const root = await mkdtemp(path.join(os.tmpdir(), `llmnav-migrate-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), `{"name":"migrate-${suffix}"}\n`);
  await writeFile(
    path.join(root, "source.js"),
    `/* llmnav/1 symbol\nid=migrate.${suffix}\nrole=Provide a stable source boundary for migration tests.\nsearch=cache migration|format upgrade\nstability=contract\n*/\nexport function source() {}\n`,
  );
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
  return root;
}
