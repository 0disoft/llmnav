import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorProject } from "../src/doctor.js";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { createProjectSession, queryProject } from "../src/search.js";

async function createProject(root, { decoy = false } = {}) {
  await writeFile(path.join(root, "package.json"), '{"name":"accelerator-recovery"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "rotate.ts"),
    `/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate one refresh-token family and reject replayed tokens.\nsearch=refresh token|token rotation|replay detection\nstability=contract\n*/\nexport function rotateSession(): void {}\n`,
  );
  if (decoy) {
    await writeFile(
      path.join(root, "src", "cache.ts"),
      "/* llmnav/1 symbol\nid=cache.entry.refresh\nrole=Refresh cached entries.\nstability=contract\n*/\nexport function refreshCache(): void {}\n",
    );
  }
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

async function corruptSearchWeights(root) {
  const searchPath = path.join(root, ".llmnav", "cache", "search-index.json");
  const searchIndex = JSON.parse(await readFile(searchPath, "utf8"));
  const decoyPosition = searchIndex.cardIds.indexOf("cache.entry.refresh");
  assert.ok(decoyPosition >= 0);
  for (const entries of searchIndex.postings) {
    for (const [position, vector] of entries) {
      if (position !== decoyPosition) continue;
      for (let offset = 1; offset < vector.length; offset += 2) vector[offset] *= 10000;
    }
  }
  const corrupted = `${JSON.stringify(searchIndex, null, 2)}\n`;
  await writeFile(searchPath, corrupted);
  return { searchPath, corrupted };
}

test("query and session rebuild structurally valid search weights that fail manifest integrity", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-weight-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root, { decoy: true });
  const expected = await queryProject(root, "refresh token");
  assert.equal(expected[0].id, "auth.session.rotate");
  const { searchPath, corrupted } = await corruptSearchWeights(root);

  assert.deepEqual(await queryProject(root, "refresh token"), expected);
  const session = await createProjectSession(root);
  assert.deepEqual(session.query("refresh token"), expected);
  assert.equal(await readFile(searchPath, "utf8"), corrupted);
  await rm(path.join(root, ".llmnav", "cache", "manifest.json"));
  assert.deepEqual(await queryProject(root, "refresh token"), expected);
});

test("generation discards corrupt search weights before reusing unchanged documents", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-weight-generation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root, { decoy: true });
  const expected = await queryProject(root, "refresh token");
  const searchPath = path.join(root, ".llmnav", "cache", "search-index.json");
  const original = await readFile(searchPath, "utf8");
  await corruptSearchWeights(root);

  const repaired = await generateProject(root);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.incremental.cards.indexedCards, 2);
  assert.equal(repaired.incremental.cards.reusedCards, 0);
  assert.equal(await readFile(searchPath, "utf8"), original);
  assert.deepEqual(await queryProject(root, "refresh token"), expected);
  const warm = await generateProject(root);
  assert.equal(warm.incremental.cards.indexedCards, 0);
  assert.equal(warm.incremental.cards.reusedCards, 2);
});

test("query rejects a mismatched primary index and preserves manifestless compatibility", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-primary-integrity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const cacheRoot = path.join(root, ".llmnav", "cache");
  const indexPath = path.join(cacheRoot, "index.json");
  const manifestPath = path.join(cacheRoot, "manifest.json");
  const original = await readFile(indexPath, "utf8");
  const changed = JSON.parse(original);
  changed.cards[0].role = "A different searchable meaning.";
  await writeFile(indexPath, `${JSON.stringify(changed)}\n`);
  await assert.rejects(() => queryProject(root, "replayed refresh token"), /Primary index\.json hash does not match manifest/u);

  changed.cards = {};
  await writeFile(indexPath, `${JSON.stringify(changed)}\n`);
  await assert.rejects(() => queryProject(root, "replayed refresh token"), /Incompatible primary index/u);
  await writeFile(manifestPath, "{malformed\n");
  await assert.rejects(() => queryProject(root, "replayed refresh token"), /Incompatible primary index/u);
  await writeFile(indexPath, "{malformed\n");
  await assert.rejects(() => queryProject(root, "replayed refresh token"), (error) => {
    assert.equal(error.message, "Malformed primary index.json. Run `llmnav generate` to rebuild it.");
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  await writeFile(indexPath, original);
  await writeFile(manifestPath, "{malformed\n");
  await assert.rejects(() => queryProject(root, "replayed refresh token"), /Malformed generated manifest/u);
  await rm(manifestPath);
  assert.equal((await queryProject(root, "replayed refresh token"))[0].id, "auth.session.rotate");
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
