/* llmnav/1 module
id=llmnav.index.generate
role=Compile validated semantic cards into deterministic repository and module catalogs for coding agents.
owns=stable card order|generated index|cache catalogs
excludes=source semantics|agent search decisions
search=repository map|semantic index|cache catalog
rel=workflow>llmnav.rules.validate
rel=workflow>llmnav.index.incremental
rel=workflow>llmnav.index.inverted
rel=workflow>llmnav.index.transaction
stability=architecture
*/

import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertAbortSignal, throwIfAborted } from "./abort.js";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { cardToCanonicalObject } from "./parser.js";
import { scanProject } from "./project.js";
import { mergeActiveIds, renderRegistryRecords } from "./registry.js";
import { countDiagnostics, validateProject } from "./validator.js";
import {
  assertNoSymlinkTraversal,
  compareText,
  readJsonSafe,
  readText,
  relativePosix,
  sha256,
  stableJson,
  stableStringify,
  toPosix,
} from "./util.js";
import { PACKAGE_VERSION, SPEC_VERSION } from "./spec.js";
import {
  buildFileStateFromProject,
  persistStatHints,
  renderFileState,
  scanProjectIncremental,
} from "./incremental.js";
import { buildInvertedIndex, renderSearchIndex } from "./inverted-index.js";
import {
  buildModuleCatalogMetadata,
  compareCardIndexes,
  describeAffectedBoundaries,
  describeAffectedCatalogs,
  moduleIdForCard,
  safeModuleName,
} from "./changes.js";
import { commitGeneratedCache, recoverGenerationTransaction, withGenerationLock } from "./transaction.js";
import { loadConfig } from "./config.js";
import { buildContractFingerprints, compareContractFingerprints } from "./contracts.js";
import { detectBoundaries } from "./boundaries.js";
import { buildSearchShards, SEARCH_SHARD_SCHEMA_VERSION } from "./search-shards.js";
import { loadProjectGraphInputs } from "./graph-input.js";
import {
  buildRepositoryGraphIncremental,
  GRAPH_SCHEMA_VERSION,
  GRAPH_STATE_SCHEMA_VERSION,
  renderGraphState,
  renderRepositoryGraph,
} from "./graph.js";
import { AGENT_PROTOCOL } from "./agents.js";
import { getAgentToolDefinitions } from "./agent-tools.js";
import {
  buildPromptPrefixBundle,
  PROMPT_BUNDLE_SCHEMA_VERSION,
  renderPromptPrefixBundle,
} from "./prompt-bundle.js";

export async function generateProject(root, options = {}) {
  return generateProjectWithPreparation(root, undefined, options);
}

/** Internal bootstrap integration; preparation and generation share the same owner. */
export async function generateProjectWithPreparation(root, prepare, options = {}) {
  assertAbortSignal(options.signal);
  throwIfAborted(options.signal);
  const lockOptions = {
    ...options.lockOptions,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    signal: options.signal,
  };
  return withGenerationLock(
    root,
    async (lock) => {
      await prepare?.();
      return generateProjectUnderLock(root, options, lock);
    },
    lockOptions,
  );
}

/**
 * Internal: run one generation while the caller already owns the generation lock.
 * Callers must have acquired the lock for the same root, so a plan and the apply
 * that depends on it cannot be invalidated by a concurrent generation.
 */
export async function generateProjectUnderLock(root, options, lock) {
  assertAbortSignal(options.signal);
  throwIfAborted(options.signal);
  return generateProjectLocked(root, { ...options, lockOwnerId: lock.ownerId, runtime: lock.runtime });
}

async function generateProjectLocked(root, options) {
  throwIfAborted(options.signal);
  const { config } = await loadConfig(root, options);
  const recovery = await recoverGenerationTransaction(root, {
    cacheDirectory: config.generation.cacheDirectory,
    renameOptions: options.renameOptions,
    lockOwnerId: options.lockOwnerId,
  });
  const cacheDirectory = path.join(root, config.generation.cacheDirectory);
  const previous = await loadPreviousArtifacts(cacheDirectory, config);
  const scan = await scanForGeneration(root, options);
  const project = scan.project;

  throwIfAborted(options.signal);
  const graphInputs = await loadProjectGraphInputs(project, options);
  project.graphInputs = graphInputs.indexes;
  const diagnostics = [...validateProject(project), ...graphInputs.diagnostics].sort(compareGeneratedDiagnostics);
  const counts = countDiagnostics(diagnostics);
  if (counts.error > 0) {
    return skippedGenerationResult(project, diagnostics, counts, scan.stats, recovery, options);
  }

  const plan = await planGeneration(root, project, options, previous, scan.fileState, diagnostics);
  const applied = await applyGeneration(root, project, plan, scan, options, recovery);
  return {
    ok: options.check ? plan.uniqueChangedFiles.length === 0 : true,
    diagnostics: plan.diagnostics,
    changedFiles: plan.uniqueChangedFiles,
    changedCards: plan.changedCards,
    affectedBoundaries: plan.affectedBoundaries,
    affectedCatalogs: plan.affectedCatalogs,
    project,
    counts: plan.counts,
    artifacts: plan.artifacts,
    index: plan.built.index,
    searchIndex: plan.built.searchIndex,
    graph: plan.built.graph,
    incremental: {
      enabled: options.incremental !== false,
      files: scan.stats,
      cards: plan.built.searchStats,
      graph: plan.built.graphStats,
      statHintsPersisted: applied.statHintsPersisted,
      statHintsError: applied.statHintsError,
    },
    transaction: applied.transaction,
  };
}

async function loadPreviousArtifacts(cacheDirectory, config) {
  const manifest = await readJsonSafe(path.join(cacheDirectory, "manifest.json"), null);
  const searchText = await readText(path.join(cacheDirectory, "search-index.json"), null);
  const cacheRelative = toPosix(config.generation.cacheDirectory).replace(/\/+$/u, "");
  let searchIndex = null;
  if (searchText !== null && manifest?.repositoryId === config.repositoryId &&
    manifest.files?.[`${cacheRelative}/search-index.json`] === sha256(searchText)) {
    try {
      searchIndex = JSON.parse(searchText);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return {
    index: await readJsonSafe(path.join(cacheDirectory, "index.json"), null),
    searchIndex,
    graphState: await readJsonSafe(path.join(cacheDirectory, "graph-state.json"), null),
  };
}

async function scanForGeneration(root, options) {
  if (options.incremental === false) {
    const project = await scanProject(root, options);
    return {
      project,
      fileState: buildFileStateFromProject(project),
      statHints: null,
      hintsPath: null,
      stats: {
        totalFiles: project.fileRecords.length,
        parsedFiles: project.fileRecords.length,
        reusedFiles: 0,
        reusedFilesByStat: 0,
        reusedFilesByHash: 0,
        deletedFiles: 0,
        bytesRead: project.sourceBytes,
        cardsParsed: project.records.length,
        cardsReused: 0,
      },
    };
  }
  const incremental = await scanProjectIncremental(root, {
    ...options,
    useStatHints: options.useStatHints,
  });
  return {
    project: incremental.project,
    fileState: incremental.fileState,
    statHints: incremental.statHints,
    hintsPath: incremental.hintsPath,
    stats: incremental.stats,
  };
}

function skippedGenerationResult(project, diagnostics, counts, scanStats, recovery, options) {
  return {
    ok: false,
    diagnostics,
    changedFiles: [],
    changedCards: [],
    affectedBoundaries: [],
    affectedCatalogs: [],
    project,
    counts,
    incremental: { enabled: options.incremental !== false, files: scanStats, cards: null, graph: null },
    transaction: { committed: false, skipped: true, recovered: recovery.recovered, recoveryAction: recovery.action },
  };
}

async function planGeneration(root, project, options, previous, fileState, initialDiagnostics) {
  throwIfAborted(options.signal);
  const ids = project.records.map((record) => record.card.id).filter(Boolean);
  const order = await buildStableOrder(root, ids);
  const built = buildArtifactSet(project, order, {
    previousSearchIndex: options.incremental === false ? null : previous.searchIndex,
    previousGraphState: options.incremental === false ? null : previous.graphState,
    fileState,
  });
  const contractChanges = compareContractFingerprints(
    previous.index?.contractFingerprints,
    built.index.contractFingerprints,
  );
  const diagnostics = [...initialDiagnostics, ...contractChanges.map(diagnosticForContractChange)]
    .sort(compareGeneratedDiagnostics);
  const counts = countDiagnostics(diagnostics);
  const changedFiles = await compareArtifacts(
    root,
    project.config.generation.cacheDirectory,
    built.artifacts,
    options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY,
  );
  const orderContent = renderOrder(order);
  const orderChanged = await compareOne(path.join(root, ".llmnav", "order.lock"), orderContent);
  if (orderChanged) changedFiles.push(".llmnav/order.lock");

  const missingRegistryIds = ids.filter((id) => !project.registry.byId.has(id));
  if (missingRegistryIds.length > 0) changedFiles.push(".llmnav/ids.jsonl");

  const uniqueChangedFiles = [...new Set(changedFiles.map(toPosix))].sort(compareText);
  const changedCards = compareCardIndexes(previous.index, built.index);
  return {
    ids,
    order,
    built,
    diagnostics,
    counts,
    orderContent,
    orderChanged,
    missingRegistryIds,
    uniqueChangedFiles,
    changedCards,
    affectedBoundaries: describeAffectedBoundaries(changedCards, project.config, previous.index, built.index),
    affectedCatalogs: describeAffectedCatalogs(
      uniqueChangedFiles,
      project.config.generation.cacheDirectory,
      project.config,
      previous.index,
      built.index,
    ),
    artifacts: built.artifacts,
  };
}

async function applyGeneration(root, project, plan, scan, options, recovery) {
  const applied = {
    transaction: { committed: false, skipped: true, recovered: recovery.recovered, recoveryAction: recovery.action },
    statHintsPersisted: false,
    statHintsError: null,
  };
  if (options.check) return applied;

  await assertNoSymlinkTraversal(root, path.join(root, ".llmnav"), ".llmnav");
  await assertNoSymlinkTraversal(
    root,
    path.join(root, project.config.generation.cacheDirectory),
    project.config.generation.cacheDirectory,
  );
  const cachePrefix = `${toPosix(project.config.generation.cacheDirectory).replace(/\/+$/u, "")}/`;
  const cacheChanges = plan.uniqueChangedFiles.filter((file) => file.startsWith(cachePrefix));
  const controlArtifacts = new Map();
  if (plan.missingRegistryIds.length > 0) {
    controlArtifacts.set(
      ".llmnav/ids.jsonl",
      renderRegistryRecords(mergeActiveIds(project.registry, plan.ids).records),
    );
  }
  if (plan.orderChanged) controlArtifacts.set(".llmnav/order.lock", plan.orderContent);
  if (cacheChanges.length > 0 || controlArtifacts.size > 0) {
    applied.transaction = await commitGeneratedCache(root, project.config.generation.cacheDirectory, plan.artifacts, {
      failpoint: options.failpoint,
      onPhase: options.onTransactionPhase,
      renameOptions: options.renameOptions,
      lockOwnerId: options.lockOwnerId,
      controlArtifacts,
      runtime: options.runtime,
      signal: options.signal,
    });
  }

  if (scan.statHints && scan.hintsPath) {
    try {
      await persistStatHints(root, scan.hintsPath, scan.statHints);
      applied.statHintsPersisted = true;
    } catch (error) {
      applied.statHintsError = error instanceof Error ? error.message : String(error);
    }
  }
  return applied;
}

export function buildArtifacts(project, order, options = {}) {
  return buildArtifactSet(project, order, options).artifacts;
}

export function buildArtifactSet(project, order, options = {}) {
  const index = buildArtifactIndex(project, order);
  const cards = index.cards;
  const { searchIndex, stats: searchStats } = buildInvertedIndex(index, options.previousSearchIndex);
  const fileState = options.fileState ?? buildFileStateFromProject(project);
  const graphBuild = buildRepositoryGraphIncremental(project, index, options.previousGraphState);
  const { graph, state: graphState, stats: graphStats } = graphBuild;

  const artifacts = new Map();
  const cacheRoot = toPosix(project.config.generation.cacheDirectory).replace(/\/+$/u, "");
  artifacts.set(`${cacheRoot}/index.json`, stableStringify(index));
  artifacts.set(
    `${cacheRoot}/cards.jsonl`,
    cards.length > 0 ? `${cards.map((card) => stableJson(card)).join("\n")}\n` : "",
  );
  artifacts.set(`${cacheRoot}/search-index.json`, renderSearchIndex(searchIndex));
  artifacts.set(`${cacheRoot}/file-state.json`, renderFileState(fileState));
  artifacts.set(`${cacheRoot}/graph.json`, renderRepositoryGraph(graph));
  artifacts.set(`${cacheRoot}/graph-state.json`, renderGraphState(graphState));
  const searchShards = buildSearchShards(index, searchIndex, project.config.generation.searchShardSize);
  if (searchShards.manifest) {
    artifacts.set(`${cacheRoot}/search-shards.json`, stableStringify(searchShards.manifest));
    for (const [relativePath, content] of searchShards.shards) {
      artifacts.set(`${cacheRoot}/${relativePath}`, content);
    }
  }

  const { moduleManifest, promptBundle } = buildCatalogArtifacts(project, cards, cacheRoot, artifacts);
  const manifest = buildArtifactManifest(project, index, { searchIndex, fileState, searchShards, moduleManifest }, artifacts);
  artifacts.set(`${cacheRoot}/manifest.json`, stableStringify(manifest));
  return { artifacts, index, searchIndex, searchStats, fileState, graph, graphState, graphStats, promptBundle, moduleManifest };
}

function buildArtifactIndex(project, order) {
  const orderMap = new Map(order.map((id, index) => [id, index]));
  const cards = project.records
    .filter((record) => record.card.id)
    .map((record) => indexedCard(record))
    .sort((left, right) => {
      const orderDifference = (orderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      return orderDifference || compareText(left.id, right.id);
    });

  const index = {
    schemaVersion: 1,
    specVersion: SPEC_VERSION,
    generatedBy: `llmnav@${PACKAGE_VERSION}`,
    repositoryId: project.config.repositoryId,
    contractFingerprints: buildContractFingerprints(project, cards),
    sourceHash: sha256(cards.map((card) => `${card.hashes.semantic}:${card.hashes.structure}:${card.hashes.body}`).join("\n")),
    cards,
  };
  return index;
}

// Artifacts is the builder-owned accumulator, never a caller's input map.
function buildCatalogArtifacts(project, cards, cacheRoot, artifacts) {
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
    const relativePath = `${cacheRoot}/modules/${safeModuleName(moduleId)}.txt`;
    artifacts.set(relativePath, renderCatalog(project.config.repositoryId, moduleId, filtered));
    moduleManifest.push({ id: moduleId, file: relativePath, cards: filtered.length });
  }

  artifacts.set(`${cacheRoot}/agent-context.md`, renderAgentContext(project.config.repositoryId, moduleManifest));
  const promptBundle = buildPromptPrefixBundle({
    repositoryId: project.config.repositoryId,
    toolDefinitions: getAgentToolDefinitions(),
    agentProtocol: AGENT_PROTOCOL,
    repositoryCore: artifacts.get(`${cacheRoot}/repo-core.txt`),
    modules: moduleManifest.map((item) => ({ id: item.id, content: artifacts.get(item.file) })),
  });
  artifacts.set(`${cacheRoot}/prompt-prefix.json`, renderPromptPrefixBundle(promptBundle));

  return { moduleManifest, promptBundle };
}

function buildArtifactManifest(project, index, { searchIndex, fileState, searchShards, moduleManifest }, artifacts) {
  const contentHashes = Object.fromEntries(
    [...artifacts.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([relativePath, content]) => [relativePath, sha256(content)]),
  );
  const manifest = {
    schemaVersion: 1,
    specVersion: SPEC_VERSION,
    repositoryId: project.config.repositoryId,
    cardCount: index.cards.length,
    moduleCount: moduleManifest.length,
    sourceHash: index.sourceHash,
    searchCardSetHash: searchIndex.cardSetHash,
    searchIndexSchemaVersion: searchIndex.schemaVersion,
    fileStateSchemaVersion: fileState.schemaVersion,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    graphStateSchemaVersion: GRAPH_STATE_SCHEMA_VERSION,
    promptBundleSchemaVersion: PROMPT_BUNDLE_SCHEMA_VERSION,
    searchShardSchemaVersion: searchShards.manifest ? SEARCH_SHARD_SCHEMA_VERSION : null,
    files: contentHashes,
  };
  return manifest;
}

function diagnosticForContractChange(change) {
  const file = change.kind === "configuration" ? ".llmnav/config.json" : ".llmnav/cache/index.json";
  const label = change.kind === "configuration" ? "Effective configuration" : "Exported API";
  return {
    severity: "warning",
    code: "LNV009",
    message: `${label} contract fingerprint changed; review the affected contract before committing generated artifacts.`,
    file,
    line: 1,
    column: 1,
  };
}

function compareGeneratedDiagnostics(left, right) {
  return compareText(left.file, right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message);
}

function indexedCard(record) {
  const canonical = cardToCanonicalObject(record.card);
  const imports = record.imports?.slice();
  const boundaries = detectBoundaries(record);
  const semanticPayload = stableJson(canonical);
  const structurePayload = stableJson({
    path: record.relativePath,
    scope: record.block.scope,
    symbol: record.declaration?.symbol ?? null,
    kind: record.declaration?.kind ?? null,
    signature: record.declaration?.signature ?? null,
    language: record.declaration?.language ?? null,
    exported: record.declaration?.exported ?? null,
    visibility: record.declaration?.visibility ?? null,
    receiver: record.declaration?.receiver ?? null,
    imports,
    boundaries,
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
      language: record.declaration?.language ?? null,
      exported: record.declaration?.exported ?? null,
      visibility: record.declaration?.visibility ?? null,
      receiver: record.declaration?.receiver ?? null,
    },
    imports,
    boundaries,
    hashes: {
      semantic: sha256(semanticPayload),
      structure: sha256(structurePayload),
      body: record.bodyHash ?? sha256(record.source ?? ""),
    },
  };
}

function groupByModule(cards, depth) {
  const groups = new Map();
  for (const card of cards) {
    const moduleId = moduleIdForCard(card.id, depth);
    const existing = groups.get(moduleId) ?? [];
    existing.push(card);
    groups.set(moduleId, existing);
  }
  return [...groups.entries()].sort(([left], [right]) => compareText(left, right));
}

function renderCatalog(repositoryId, catalogId, cards) {
  const lines = [
    `llmnav-catalog/1 repository=${repositoryId} catalog=${catalogId}`,
    "Read semantic cards before opening source. Resolve current paths and signatures with llmnav query or show.",
    "",
  ];
  for (const card of cards) lines.push(renderSemanticCard(card), "");
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
  const additions = [...new Set(ids)].filter((id) => !seen.has(id)).sort(compareText);
  return [...existing, ...additions];
}

function renderOrder(order) {
  return order.length > 0 ? `${order.join("\n")}\n` : "";
}

async function compareArtifacts(root, cacheDirectory, artifacts, ioConcurrency) {
  const entries = [...artifacts];
  const differences = await mapWithConcurrency(entries, ioConcurrency, ([relativePath, content]) =>
    compareOne(path.join(root, relativePath), content));
  const changed = [];
  for (const [index, [relativePath]] of entries.entries()) {
    if (differences[index]) changed.push(toPosix(relativePath));
  }
  const actualFiles = await listFiles(path.join(root, cacheDirectory));
  const expected = new Set([...artifacts.keys()].map((item) => toPosix(item)));
  for (const absolutePath of actualFiles) {
    const relativePath = relativePosix(root, absolutePath);
    if (!expected.has(relativePath)) changed.push(relativePath);
  }
  return changed.sort(compareText);
}

async function compareOne(filePath, expected) {
  const actual = await readText(filePath, null);
  return actual !== expected;
}

async function listFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
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

export { buildModuleCatalogMetadata };
