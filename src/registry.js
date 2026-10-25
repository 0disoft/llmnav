/* llmnav/1 module
id=llmnav.registry.ids
role=Validate and evolve semantic ID lifecycle records across active, redirect, replaced, and retired states.
owns=semantic ID registry|redirect resolution|replacement lifecycle
excludes=source card parsing|search ranking
search=semantic id registry|redirected id|retired id
invariant=Registry resolution never silently chooses among multiple replacement targets.
rel=workflow>llmnav.index.generate
stability=contract
*/

import path from "node:path";
import { ID_PATTERN } from "./spec.js";
import { withGenerationLock } from "./transaction.js";
import { assertNoSymlinkTraversal, atomicWrite, parseJsonLines, readText } from "./util.js";

const REGISTRY_STATES = new Set(["active", "redirect", "replaced", "retired"]);
const REGISTRY_KEYS = new Set(["id", "state", "to", "by"]);

export async function loadRegistry(root, options = {}) {
  const registryPath = path.join(root, ".llmnav", "ids.jsonl");
  await assertNoSymlinkTraversal(root, registryPath, ".llmnav/ids.jsonl");
  const text = await readText(registryPath, "", options);
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

export async function ensureActiveIds(root, registry, ids, options = {}) {
  const registryPath = path.join(root, ".llmnav", "ids.jsonl");
  if (path.resolve(registry.registryPath) !== path.resolve(registryPath)) {
    throw new Error("Registry path does not belong to the requested project root.");
  }
  if (options.lockOwnerId !== undefined) {
    return mergeActiveIdsUnderLock(root, registryPath, ids);
  }
  return withGenerationLock(
    root,
    () => mergeActiveIdsUnderLock(root, registryPath, ids),
    options.lockOptions,
  );
}

async function mergeActiveIdsUnderLock(root, registryPath, ids) {
  await assertNoSymlinkTraversal(root, registryPath, ".llmnav/ids.jsonl");
  // Re-read inside the lock: the caller's snapshot may predate another writer,
  // and the registry is briefly absent while generation swaps control artifacts.
  const current = await loadRegistry(root);
  // A stale snapshot cannot repair invalid current data without losing lifecycle changes.
  if (current.errors.length > 0) {
    throw new Error(`Cannot update invalid semantic ID registry:\n${current.errors.join("\n")}`);
  }
  const { records, changed } = mergeActiveIds(current, ids);
  if (changed) await atomicWrite(root, registryPath, renderRegistryRecords(records));
  return { records, changed };
}

export function mergeActiveIds(registry, ids) {
  const records = [...registry.records];
  const known = new Set(records.map((record) => record.id));
  let changed = false;
  for (const id of ids) {
    if (known.has(id)) continue;
    records.push({ id, state: "active" });
    known.add(id);
    changed = true;
  }
  return { records, changed };
}

export function renderRegistryRecords(records) {
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  return content ? `${content}\n` : "";
}

export function resolveRegistryId(registry, id) {
  const chain = [];
  const positions = new Map();
  let current = id;
  for (;;) {
    if (positions.has(current)) return cycleResult(current, chain, positions);
    positions.set(current, chain.length);
    chain.push(current);
    const record = registry.byId.get(current);
    if (!record) return { id: current, state: "unknown", chain };
    const targets = registryTargets(record);
    if (targets.length === 1) {
      current = targets[0];
      continue;
    }
    if (record.state === "replaced" && Array.isArray(record.by)) {
      const cycle = firstRegistryCycle(registry, targets, chain, positions);
      return cycle ?? { id: current, state: "ambiguous", chain, candidates: [...record.by] };
    }
    return { id: current, state: record.state ?? "unknown", chain };
  }
}

function registryTargets(record) {
  if (record?.state === "redirect" && record.to) return [record.to];
  return record?.state === "replaced" && Array.isArray(record.by) ? record.by : [];
}

// State-only queries share tails during one synchronous validation pass. Discard on mutation.
// Full resolutions still use resolveRegistryId to preserve ordered candidates and cycle witnesses.
export function createRegistryStateResolver(registry, cyclicIds = cyclicRegistryIds(registry)) {
  const states = new Map();
  return (id) => {
    const trail = [];
    let current = id;
    let state;
    for (;;) {
      if (states.has(current)) {
        state = states.get(current);
        break;
      }
      if (cyclicIds.has(current)) {
        state = "cycle";
        break;
      }
      trail.push(current);
      const record = registry.byId.get(current);
      if (!record) {
        state = "unknown";
        break;
      }
      const targets = registryTargets(record);
      if (targets.length === 1) {
        current = targets[0];
        continue;
      }
      state = record.state === "replaced" && Array.isArray(record.by) ? "ambiguous" : record.state ?? "unknown";
      break;
    }
    for (const visited of trail) states.set(visited, state);
    return state;
  };
}

function cycleResult(current, chain, positions) {
  return { id: current, state: "cycle", chain: [...chain.slice(positions.get(current)), current] };
}

function firstRegistryCycle(registry, targets, chain, positions) {
  const stack = [{ targets, cursor: 0, owner: null }];
  const finished = new Set();
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.cursor === frame.targets.length) {
      stack.pop();
      if (frame.owner !== null) {
        positions.delete(frame.owner);
        chain.pop();
        finished.add(frame.owner);
      }
      continue;
    }
    const current = frame.targets[frame.cursor++];
    if (positions.has(current)) return cycleResult(current, chain, positions);
    if (finished.has(current)) continue;
    const next = registryTargets(registry.byId.get(current));
    if (next.length === 0) {
      finished.add(current);
      continue;
    }
    positions.set(current, chain.length);
    chain.push(current);
    stack.push({ targets: next, cursor: 0, owner: current });
  }
  return null;
}

/** IDs that can reach a cycle, including incoming redirects and replacements. */
export function cyclicRegistryIds(registry) {
  const remaining = new Map();
  const incoming = new Map();
  const queue = [];
  for (const [id, record] of registry.byId) {
    let count = 0;
    for (const target of registryTargets(record)) {
      if (!registry.byId.has(target)) continue;
      count++;
      const sources = incoming.get(target) ?? [];
      sources.push(id);
      incoming.set(target, sources);
    }
    remaining.set(id, count);
    if (count === 0) queue.push(id);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const source of incoming.get(queue[cursor]) ?? []) {
      const count = remaining.get(source) - 1;
      remaining.set(source, count);
      if (count === 0) queue.push(source);
    }
  }
  return new Set([...remaining].filter(([, count]) => count > 0).map(([id]) => id));
}
