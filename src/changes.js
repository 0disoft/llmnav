/* llmnav/1 module
id=llmnav.index.changes
role=Describe changed semantic cards and generated catalogs as stable machine-readable records.
owns=card diff|catalog impact report|change ordering
excludes=source mutation|cache commit
search=changed cards|affected catalog|generation report
rel=workflow>llmnav.index.generate
stability=architecture
*/

import { compareText, toPosix } from "./util.js";

const HASH_DIMENSIONS = Object.freeze(["semantic", "structure", "body"]);

export function compareCardIndexes(previousIndex, currentIndex) {
  const previous = new Map((previousIndex?.cards ?? []).map((card) => [card.id, card]));
  const current = new Map((currentIndex?.cards ?? []).map((card) => [card.id, card]));
  const ids = [...new Set([...previous.keys(), ...current.keys()])].sort(compareText);
  const changes = [];

  for (const id of ids) {
    const before = previous.get(id);
    const after = current.get(id);
    if (!before) {
      changes.push({
        id,
        change: "added",
        dimensions: [...HASH_DIMENSIONS],
        previous: null,
        current: cardSnapshot(after),
      });
      continue;
    }
    if (!after) {
      changes.push({
        id,
        change: "removed",
        dimensions: [...HASH_DIMENSIONS],
        previous: cardSnapshot(before),
        current: null,
      });
      continue;
    }
    const dimensions = HASH_DIMENSIONS.filter((dimension) => before.hashes?.[dimension] !== after.hashes?.[dimension]);
    if (dimensions.length === 0) continue;
    changes.push({
      id,
      change: "modified",
      dimensions,
      previous: cardSnapshot(before),
      current: cardSnapshot(after),
    });
  }
  return changes;
}

export function describeAffectedCatalogs(changedFiles, cacheDirectory, config, previousIndex, currentIndex) {
  const cacheRoot = toPosix(cacheDirectory).replace(/\/+$/u, "");
  const known = new Map([
    [`${cacheRoot}/repo-core.txt`, { kind: "repository", id: "repository" }],
    [`${cacheRoot}/agent-context.md`, { kind: "agent-context", id: "agent-context" }],
  ]);
  for (const index of [previousIndex, currentIndex]) {
    for (const module of buildModuleCatalogMetadata(index?.cards ?? [], config)) {
      known.set(module.file, { kind: "module", id: module.id });
    }
  }

  return [...new Set(changedFiles.map(toPosix))]
    .filter((file) => known.has(file))
    .sort(compareText)
    .map((file) => ({ file, ...known.get(file) }));
}

export function buildModuleCatalogMetadata(cards, config) {
  const groups = new Map();
  for (const card of cards) {
    if (!config.generation.moduleCatalogStabilities.includes(card.stability)) continue;
    const id = moduleIdForCard(card.id, config.generation.moduleDepth);
    const count = groups.get(id) ?? 0;
    groups.set(id, count + 1);
  }
  const cacheRoot = toPosix(config.generation.cacheDirectory).replace(/\/+$/u, "");
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, cardsCount]) => ({
      id,
      file: `${cacheRoot}/modules/${safeModuleName(id)}.txt`,
      cards: cardsCount,
    }));
}

export function moduleIdForCard(id, depth) {
  const segments = String(id).split(".");
  return segments.slice(0, Math.min(Math.max(depth, 1), segments.length)).join(".");
}

export function safeModuleName(id) {
  return String(id).replace(/[^a-z0-9.-]/gu, "-");
}

function cardSnapshot(card) {
  return {
    stability: card?.stability ?? null,
    module: card?.id ? card.id.split(".").slice(0, 2).join(".") : null,
    location: card?.location
      ? {
          path: card.location.path,
          symbol: card.location.symbol ?? null,
          declarationLine: card.location.declarationLine ?? null,
        }
      : null,
    hashes: card?.hashes
      ? {
          semantic: card.hashes.semantic,
          structure: card.hashes.structure,
          body: card.hashes.body,
        }
      : null,
  };
}
