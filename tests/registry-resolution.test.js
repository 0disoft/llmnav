import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cyclicRegistryIds, ensureActiveIds, loadRegistry, resolveRegistryId } from "../src/registry.js";
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

test("long redirect chains resolve without recursive stack growth", () => {
  const records = Array.from({ length: 20000 }, (_, index) => ({
    id: `node.${index}`, state: "redirect", to: `node.${index + 1}`,
  }));
  records.push({ id: "node.20000", state: "active" });
  const registry = registryFrom(records);
  const resolved = resolveRegistryId(registry, "node.0");
  assert.equal(resolved.id, "node.20000");
  assert.equal(resolved.chain.length, records.length);
  assert.equal(cyclicRegistryIds(registry).size, 0);
  records[records.length - 1].state = "redirect";
  records[records.length - 1].to = "node.19999";
  assert.deepEqual(resolveRegistryId(registry, "node.0").chain, ["node.19999", "node.20000", "node.19999"]);
  assert.equal(cyclicRegistryIds(registry).size, records.length);
});

test("reconverging replacements preserve candidate order without reporting shared nodes as cycles", () => {
  const records = [{ id: "end", state: "active" }];
  for (let index = 100; index >= 0; index--) {
    const by = index === 100 ? ["end"] : [`left.${index + 1}`, `right.${index + 1}`];
    records.push({ id: `left.${index}`, state: "replaced", by }, { id: `right.${index}`, state: "replaced", by });
  }
  const registry = registryFrom(records);
  assert.deepEqual(resolveRegistryId(registry, "left.0"), {
    id: "left.0", state: "ambiguous", chain: ["left.0"], candidates: ["left.1", "right.1"],
  });
  assert.equal(cyclicRegistryIds(registry).size, 0);
});

test("cycle diagnostics include incoming branches and retain the first cycle witness", () => {
  const registry = registryFrom([
    { id: "root", state: "replaced", by: ["second", "first", "missing"] },
    { id: "first", state: "redirect", to: "first" },
    { id: "second", state: "redirect", to: "second" },
    { id: "safe", state: "replaced", by: ["missing", "retired"] },
    { id: "retired", state: "retired" },
  ]);
  assert.deepEqual(resolveRegistryId(registry, "root"), { id: "second", state: "cycle", chain: ["second", "second"] });
  assert.deepEqual([...cyclicRegistryIds(registry)], ["root", "first", "second"]);
});
