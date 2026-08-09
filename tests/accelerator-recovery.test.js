import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorProject } from "../src/doctor.js";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { queryProject } from "../src/search.js";

async function createProject(root) {
  await writeFile(path.join(root, "package.json"), '{"name":"accelerator-recovery"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "rotate.ts"),
    `/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate one refresh-token family and reject replayed tokens.\nsearch=refresh token|token rotation|replay detection\nstability=contract\n*/\nexport function rotateSession(): void {}\n`,
  );
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
}

test("query rebuilds a malformed search accelerator from the compatible primary index", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-search-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const searchPath = path.join(root, ".llmnav", "cache", "search-index.json");
  await writeFile(searchPath, "{malformed\n");

  const [result] = await queryProject(root, "replayed refresh token");
  assert.equal(result.id, "auth.session.rotate");
  assert.equal(await readFile(searchPath, "utf8"), "{malformed\n");
});

test("generation repairs malformed incremental accelerators from source", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-generation-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const cacheRoot = path.join(root, ".llmnav", "cache");
  await writeFile(path.join(cacheRoot, "search-index.json"), "[broken\n");
  await writeFile(path.join(cacheRoot, "file-state.json"), "{broken\n");
  await writeFile(path.join(cacheRoot, "graph-state.json"), "{broken\n");
  const sourcePath = path.join(root, "src", "rotate.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("one refresh-token", "a refresh-token"));

  const generated = await generateProject(root);
  assert.equal(generated.ok, true);
  assert.equal(generated.incremental.files.parsedFiles, 1);
  assert.equal(generated.incremental.cards.indexedCards, 1);
  assert.equal(generated.incremental.graph.rebuiltPartitions, 1);
  assert.doesNotThrow(() => JSON.parse(generated.artifacts.get(".llmnav/cache/search-index.json")));
  assert.doesNotThrow(() => JSON.parse(generated.artifacts.get(".llmnav/cache/file-state.json")));
  assert.doesNotThrow(() => JSON.parse(generated.artifacts.get(".llmnav/cache/graph-state.json")));

  const doctor = await doctorProject(root);
  assert.ok(doctor.checks.some((check) => check.name === "search-index-integrity" && check.ok));
  assert.ok(doctor.checks.some((check) => check.name === "file-state-integrity" && check.ok));
  assert.ok(doctor.checks.some((check) => check.message === "generated files match a full source rebuild"));
});


test("query rejects a corrupted posting table even when metadata still matches", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-posting-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const searchPath = path.join(root, ".llmnav", "cache", "search-index.json");
  const searchIndex = JSON.parse(await readFile(searchPath, "utf8"));
  const posting = searchIndex.postings.find((entries) => entries.length > 0);
  assert.ok(posting);
  posting[0][0] = searchIndex.cardIds.length + 10;
  await writeFile(searchPath, `${JSON.stringify(searchIndex, null, 2)}\n`);

  const [result] = await queryProject(root, "replayed refresh token");
  assert.equal(result.id, "auth.session.rotate");
});
