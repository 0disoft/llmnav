import assert from "node:assert/strict";
import test from "node:test";
import { resolveRegistryId } from "../src/registry.js";

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

function registryFrom(records) {
  return { records, byId: new Map(records.map((record) => [record.id, record])) };
}
