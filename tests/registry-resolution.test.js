import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureActiveIds, loadRegistry, resolveRegistryId } from "../src/registry.js";
import { scanProject } from "../src/project.js";

test("multi-target replacements remain explicit instead of choosing the first entry", () => {
  const registry = registryFrom([
    { id: "billing.credit.charge", state: "replaced", by: ["billing.credit.reserve", "billing.credit.capture"] },
    { id: "billing.credit.reserve", state: "active" },
    { id: "billing.credit.capture", state: "active" },
  ]);
  assert.deepEqual(resolveRegistryId(registry, "billing.credit.charge"), {
    id: "billing.credit.charge",
    state: "ambiguous",
    chain: ["billing.credit.charge"],
    candidates: ["billing.credit.reserve", "billing.credit.capture"],
  });
});

test("single-target replacements and redirects still resolve to active IDs", () => {
  const registry = registryFrom([
    { id: "old.name", state: "redirect", to: "split.name" },
    { id: "split.name", state: "replaced", by: ["active.name"] },
    { id: "active.name", state: "active" },
  ]);
  assert.deepEqual(resolveRegistryId(registry, "old.name"), {
    id: "active.name",
    state: "active",
    chain: ["old.name", "split.name", "active.name"],
  });
});

test("cycles hidden in one replacement branch are detected", () => {
  const registry = registryFrom([
    { id: "old.name", state: "replaced", by: ["active.name", "cycle.name"] },
    { id: "active.name", state: "active" },
    { id: "cycle.name", state: "redirect", to: "old.name" },
  ]);
  assert.deepEqual(resolveRegistryId(registry, "old.name"), {
    id: "old.name",
    state: "cycle",
    chain: ["old.name", "cycle.name", "old.name"],
  });
});

test("merging active IDs re-reads the registry inside the generation lock", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-registry-"));
  context.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("llmnav-registry-"));
    await rm(root, { recursive: true, force: true });
  });
  const first = await loadRegistry(root);
  const stale = await loadRegistry(root);
  await ensureActiveIds(root, first, ["alpha.one"]);
  await ensureActiveIds(root, stale, ["beta.two"]);
  const final = await loadRegistry(root);
  assert.deepEqual(final.records.map((record) => record.id), ["alpha.one", "beta.two"]);
  assert.deepEqual(final.errors, []);
});

test("scanning accepts a registry prepared by the caller", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-registry-scan-"));
  context.after(async () => {
    assert.ok(path.basename(root).startsWith("llmnav-registry-scan-"));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "package.json"), '{"name":"registry-scan-fixture"}\n');
  const injected = {
    records: [{ id: "prepared.only", state: "active" }],
    byId: new Map([["prepared.only", { id: "prepared.only", state: "active" }]]),
    registryPath: path.join(root, ".llmnav", "ids.jsonl"),
  };
  const project = await scanProject(root, { registry: injected });
  assert.equal(project.registry, injected);
});

function registryFrom(records) {
  return { records, byId: new Map(records.map((record) => [record.id, record])) };
}
