/* llmnav/1 module
id=llmnav.index.generate
role=Compile validated semantic cards into deterministic repository and module catalogs for coding agents.
owns=stable card order|generated index|cache catalogs
excludes=source semantics|agent search decisions
search=repository map|semantic index|cache catalog
rel=workflow>llmnav.rules.validate
stability=architecture
*/

import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { cardToCanonicalObject } from "./parser.js";
import { scanProject } from "./project.js";
import { ensureActiveIds } from "./registry.js";
import { countDiagnostics, validateProject } from "./validator.js";
import {
  atomicWrite,
  assertNoSymlinkTraversal,
  readText,
  relativePosix,
  sha256,
  stableStringify,
  toPosix,
} from "./util.js";
import { PACKAGE_VERSION, SPEC_VERSION } from "./spec.js";

export async function generateProject(root, options = {}) {
  const project = await scanProject(root, options);
  const diagnostics = validateProject(project);
  const counts = countDiagnostics(diagnostics);
  if (counts.error > 0) {
    return { ok: false, diagnostics, changedFiles: [], project, counts };
  }

  const ids = project.records.map((record) => record.card.id).filter(Boolean);
  const order = await buildStableOrder(root, ids);
  const artifacts = buildArtifacts(project, order);
  const changedFiles = await compareArtifacts(root, project.config.generation.cacheDirectory, artifacts);
  const orderChanged = await compareOne(path.join(root, ".llmnav", "order.lock"), renderOrder(order));
  if (orderChanged) changedFiles.push(".llmnav/order.lock");

  const missingRegistryIds = ids.filter((id) => !project.registry.byId.has(id));
  if (missingRegistryIds.length > 0) changedFiles.push(".llmnav/ids.jsonl");

  if (!options.check) {
    await assertNoSymlinkTraversal(root, path.join(root, ".llmnav"), ".llmnav");
    await assertNoSymlinkTraversal(
      root,
      path.join(root, project.config.generation.cacheDirectory),
      project.config.generation.cacheDirectory,
    );
    await ensureActiveIds(root, project.registry, ids);
    await atomicWrite(path.join(root, ".llmnav", "order.lock"), renderOrder(order));
    const cacheDirectory = path.join(root, project.config.generation.cacheDirectory);
    await rm(cacheDirectory, { recursive: true, force: true });
    await mkdir(cacheDirectory, { recursive: true });
    for (const [relativePath, content] of artifacts) {
      await atomicWrite(path.join(root, relativePath), content);
    }
  }

  return {
    ok: options.check ? changedFiles.length === 0 : true,
    diagnostics,
    changedFiles: [...new Set(changedFiles)].sort(),
    project,
    counts,
    artifacts,
  };
}

export function buildArtifacts(project, order) {
  const orderMap = new Map(order.map((id, index) => [id, index]));
  const cards = project.records
    .filter((record) => record.card.id)
    .map((record) => indexedCard(record))
    .sort((left, right) => (orderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (orderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER));

  const index = {
    schemaVersion: 1,
    specVersion: SPEC_VERSION,
    generatedBy: `llmnav@${PACKAGE_VERSION}`,
    repositoryId: project.config.repositoryId,
    sourceHash: sha256(cards.map((card) => `${card.hashes.semantic}:${card.hashes.structure}:${card.hashes.body}`).join("\n")),
    cards,
  };

  const artifacts = new Map();
  const cacheRoot = toPosix(project.config.generation.cacheDirectory);
  artifacts.set(`${cacheRoot}/index.json`, stableStringify(index));
  artifacts.set(
    `${cacheRoot}/cards.jsonl`,
    cards.length > 0 ? `${cards.map((card) => JSON.stringify(card)).join("\n")}\n` : "",
  );

  const repositoryCards = cards.filter((card) =>
    project.config.generation.repositoryCatalogStabilities.includes(card.stability),
  );
  artifacts.set(`${cacheRoot}/repo-core.txt`, renderCatalog(project.config.repositoryId, "repository", repositoryCards));

  const modules = groupByModule(cards, project.config.generation.moduleDepth);
  const moduleManifest = [];
  for (const [moduleId, moduleCards] of modules) {
    const filtered = moduleCards.filter((card) =>
      project.config.generation.moduleCatalogStabilities.includes(card.stability),
    );
    if (filtered.length === 0) continue;
    const safeName = moduleId.replace(/[^a-z0-9.-]/gu, "-");
    const relativePath = `${cacheRoot}/modules/${safeName}.txt`;
    artifacts.set(relativePath, renderCatalog(project.config.repositoryId, moduleId, filtered));
    moduleManifest.push({ id: moduleId, file: relativePath, cards: filtered.length });
  }

  artifacts.set(`${cacheRoot}/agent-context.md`, renderAgentContext(project.config.repositoryId, moduleManifest));

  const contentHashes = Object.fromEntries(
    [...artifacts.entries()].map(([relativePath, content]) => [relativePath, sha256(content)]),
  );
  const manifest = {
    schemaVersion: 1,
    specVersion: SPEC_VERSION,
    repositoryId: project.config.repositoryId,
    cardCount: cards.length,
    moduleCount: moduleManifest.length,
    sourceHash: index.sourceHash,
    files: contentHashes,
  };
  artifacts.set(`${cacheRoot}/manifest.json`, stableStringify(manifest));
  return artifacts;
}

function indexedCard(record) {
  const canonical = cardToCanonicalObject(record.card);
  const semanticPayload = JSON.stringify(canonical);
  const structurePayload = JSON.stringify({
    path: record.relativePath,
    scope: record.block.scope,
    symbol: record.declaration?.symbol ?? null,
    kind: record.declaration?.kind ?? null,
    signature: record.declaration?.signature ?? null,
    imports: record.imports,
  });
  return {
    ...canonical,
    location: {
      path: record.relativePath,
      startLine: record.block.startLine,
      endLine: record.block.endLine,
      symbol: record.declaration?.symbol ?? null,
      kind: record.declaration?.kind ?? null,
      declarationLine: record.declaration?.line ?? null,
      signature: record.declaration?.signature ?? null,
    },
    imports: record.imports,
    hashes: {
      semantic: sha256(semanticPayload),
      structure: sha256(structurePayload),
      body: sha256(record.source),
    },
  };
}

function groupByModule(cards, depth) {
  const groups = new Map();
  for (const card of cards) {
    const segments = card.id.split(".");
    const moduleId = segments.slice(0, Math.min(Math.max(depth, 1), segments.length)).join(".");
    const existing = groups.get(moduleId) ?? [];
    existing.push(card);
    groups.set(moduleId, existing);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function renderCatalog(repositoryId, catalogId, cards) {
  const lines = [
    `llmnav-catalog/1 repository=${repositoryId} catalog=${catalogId}`,
    "Read semantic cards before opening source. Resolve current paths and signatures with llmnav query or show.",
    "",
  ];
  for (const card of cards) {
    lines.push(renderSemanticCard(card), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSemanticCard(card) {
  const lines = [`@${card.id}`, `role ${card.role}`];
  if (card.owns?.length) lines.push(`owns ${card.owns.join(", ")}`);
  if (card.excludes?.length) lines.push(`excludes ${card.excludes.join(", ")}`);
  if (card.invariant?.length) lines.push(`invariant ${card.invariant.join(" ")}`);
  if (card.effect?.length) lines.push(`effect ${card.effect.join(", ")}`);
  if (card.risk?.length) lines.push(`risk ${card.risk.join(", ")}`);
  if (card.rel?.length) lines.push(`rel ${card.rel.join(", ")}`);
  return lines.join("\n");
}

export function renderCompactCard(card) {
  const lines = renderSemanticCard(card).split("\n");
  const location = card.location;
  if (location) {
    const symbol = location.symbol ? `#${location.symbol}` : "";
    lines.push(`loc ${location.path}${symbol}:${location.declarationLine ?? location.startLine}`);
    if (location.signature) lines.push(`sig ${location.signature}`);
  }
  return lines.join("\n");
}

function renderAgentContext(repositoryId, modules) {
  const lines = [
    "# LLMNav generated context",
    "",
    `Repository: ${repositoryId}`,
    "",
    "Use `npm exec -- llmnav query \"<task>\" --top 5` before broad directory scans or grep.",
    "Use `npm exec -- llmnav show <id>` to resolve one semantic card and `npm exec -- llmnav context <id>` for related cards.",
    "Treat paths, line numbers, signatures, imports, and hashes as generated data.",
    "Keep semantic IDs stable across moves and renames.",
    "",
    "## Module catalogs",
    "",
  ];
  if (modules.length === 0) lines.push("No module catalogs have been generated yet.");
  for (const module of modules) lines.push(`* ${module.id}: ${module.file} (${module.cards} cards)`);
  return `${lines.join("\n")}\n`;
}

async function buildStableOrder(root, ids) {
  const existing = (await readText(path.join(root, ".llmnav", "order.lock"), ""))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const seen = new Set(existing);
  const additions = [...new Set(ids)].filter((id) => !seen.has(id)).sort();
  return [...existing, ...additions];
}

function renderOrder(order) {
  return order.length > 0 ? `${order.join("\n")}\n` : "";
}

async function compareArtifacts(root, cacheDirectory, artifacts) {
  const changed = [];
  for (const [relativePath, content] of artifacts) {
    if (await compareOne(path.join(root, relativePath), content)) changed.push(relativePath);
  }
  const actualFiles = await listFiles(path.join(root, cacheDirectory));
  const expected = new Set([...artifacts.keys()].map((item) => toPosix(item)));
  for (const absolutePath of actualFiles) {
    const relativePath = relativePosix(root, absolutePath);
    if (!expected.has(relativePath)) changed.push(relativePath);
  }
  return changed;
}

async function compareOne(filePath, expected) {
  const actual = await readText(filePath, null);
  return actual !== expected;
}

async function listFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
      else if (entry.isFile()) files.push(absolute);
    }
    return files;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
}
