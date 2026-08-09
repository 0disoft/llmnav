import path from "node:path";
import { ID_PATTERN } from "./spec.js";
import { atomicWrite, parseJsonLines, readText } from "./util.js";

const REGISTRY_STATES = new Set(["active", "redirect", "replaced", "retired"]);
const REGISTRY_KEYS = new Set(["id", "state", "to", "by"]);

export async function loadRegistry(root) {
  const registryPath = path.join(root, ".llmnav", "ids.jsonl");
  const text = await readText(registryPath, "");
  const parsed = parseJsonLines(text, registryPath);
  const byId = new Map();
  const errors = [...parsed.errors];

  for (const record of parsed.records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      errors.push(`${registryPath}: registry records must be JSON objects`);
      continue;
    }
    for (const key of Object.keys(record)) {
      if (!REGISTRY_KEYS.has(key)) errors.push(`${registryPath}: registry record contains unknown property ${JSON.stringify(key)}`);
    }
    if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) {
      errors.push(`${registryPath}: registry records require a valid local semantic id`);
      continue;
    }
    if (byId.has(record.id)) errors.push(`${registryPath}: duplicate registry id ${record.id}`);
    byId.set(record.id, record);

    if (!REGISTRY_STATES.has(record.state)) {
      errors.push(`${registryPath}: registry id ${record.id} has invalid state ${JSON.stringify(record.state)}`);
      continue;
    }
    if (record.state === "active" || record.state === "retired") {
      if (record.to !== undefined || record.by !== undefined) {
        errors.push(`${registryPath}: ${record.state} registry id ${record.id} must not declare to or by`);
      }
    } else if (record.state === "redirect") {
      if (typeof record.to !== "string" || !ID_PATTERN.test(record.to)) {
        errors.push(`${registryPath}: redirect registry id ${record.id} requires a valid to id`);
      }
      if (record.by !== undefined) errors.push(`${registryPath}: redirect registry id ${record.id} must not declare by`);
    } else if (record.state === "replaced") {
      if (!Array.isArray(record.by) || record.by.length === 0) {
        errors.push(`${registryPath}: replaced registry id ${record.id} requires a non-empty by array`);
      } else {
        const seen = new Set();
        for (const target of record.by) {
          if (typeof target !== "string" || !ID_PATTERN.test(target)) {
            errors.push(`${registryPath}: replaced registry id ${record.id} contains an invalid replacement id`);
            continue;
          }
          if (seen.has(target)) errors.push(`${registryPath}: replaced registry id ${record.id} repeats replacement ${target}`);
          seen.add(target);
        }
      }
      if (record.to !== undefined) errors.push(`${registryPath}: replaced registry id ${record.id} must not declare to`);
    }
  }
  return { registryPath, records: [...byId.values()], byId, errors };
}

export async function ensureActiveIds(root, registry, ids) {
  const records = [...registry.records];
  const known = new Set(records.map((record) => record.id));
  let changed = false;
  for (const id of ids) {
    if (known.has(id)) continue;
    records.push({ id, state: "active" });
    known.add(id);
    changed = true;
  }
  if (changed) {
    const content = records.map((record) => JSON.stringify(record)).join("\n");
    await atomicWrite(registry.registryPath, `${content}\n`);
  }
  return { records, changed };
}

export function resolveRegistryId(registry, id) {
  const visited = new Set();
  let current = id;
  for (;;) {
    if (visited.has(current)) return { id: current, state: "cycle", chain: [...visited, current] };
    visited.add(current);
    const record = registry.byId.get(current);
    if (!record) return { id: current, state: "unknown", chain: [...visited] };
    if (record.state === "active") return { id: current, state: "active", chain: [...visited] };
    const target = record.to ?? (Array.isArray(record.by) ? record.by[0] : undefined);
    if (!target) return { id: current, state: record.state ?? "unknown", chain: [...visited] };
    current = target;
  }
}
