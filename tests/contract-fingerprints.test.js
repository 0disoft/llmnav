import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";

test("fingerprints exported API and effective configuration contracts", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-contract-fingerprint-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"contract-fingerprint-fixture"}\n');
  await mkdir(path.join(root, "src"));
  const sourcePath = path.join(root, "src", "reserve.ts");
  await writeFile(sourcePath, source("export function reserveCredits(input: number): number { return input; }"));

  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
  const first = JSON.parse(await readFile(path.join(root, ".llmnav", "cache", "index.json"), "utf8"));
  assert.equal(first.contractFingerprints.schemaVersion, 1);
  assert.equal(first.contractFingerprints.exportedApi.count, 1);

  await writeFile(sourcePath, source("export function reserveCredits(input: number): number { return input + 1; }"));
  const bodyOnly = await generateProject(root);
  assert.equal(bodyOnly.ok, true);
  assert.equal(bodyOnly.index.contractFingerprints.exportedApi.sha256, first.contractFingerprints.exportedApi.sha256);
  assert.equal(bodyOnly.diagnostics.some((item) => item.code === "LNV009"), false);

  await writeFile(sourcePath, source("export function reserveCredits(input: string): number { return input.length; }"));
  const apiChange = await generateProject(root);
  assert.equal(apiChange.ok, true);
  assert.notEqual(apiChange.index.contractFingerprints.exportedApi.sha256, first.contractFingerprints.exportedApi.sha256);
  assert.ok(apiChange.diagnostics.some((item) => item.code === "LNV009" && /Exported API/u.test(item.message)));

  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.generation.moduleDepth = 3;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const configChange = await generateProject(root);
  assert.equal(configChange.ok, true);
  assert.ok(configChange.diagnostics.some((item) => item.code === "LNV009" && /configuration/u.test(item.message)));
});

function source(declaration) {
  return `/* llmnav/1 symbol\nid=billing.credit.reserve\nrole=Reserve credits before an external generation job starts.\nsearch=credit hold|reserve credits\nstability=contract\n*/\n${declaration}\n`;
}
