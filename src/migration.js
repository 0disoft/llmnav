/* llmnav/1 module
id=llmnav.project.migrate
role=Plan and apply safe generated-format upgrades from canonical repository source.
owns=migration planning|format compatibility reporting|full transactional regeneration
excludes=source-card rewriting|semantic ID reassignment
search=llmnav migrate|cache format upgrade|migration dry run
invariant=Check mode never commits generated artifacts.
invariant=Write mode stops before mutation when canonical source validation fails.
rel=workflow>llmnav.index.generate
rel=workflow>llmnav.index.transaction
stability=contract
*/

import path from "node:path";
import { loadConfig } from "./config.js";
import { generateProject } from "./generator.js";
import { compatibleGraphState, GRAPH_SCHEMA_VERSION, GRAPH_STATE_SCHEMA_VERSION, isCompatibleRepositoryGraph } from "./graph.js";
import { FILE_STATE_SCHEMA_VERSION, SOURCE_INDEXER_VERSION, usableFileState } from "./incremental.js";
import { isCompatibleSearchIndex, SEARCH_INDEX_ENCODING, SEARCH_INDEX_SCHEMA_VERSION } from "./inverted-index.js";
import { isCompatiblePromptPrefixBundle, PROMPT_BUNDLE_SCHEMA_VERSION } from "./prompt-bundle.js";
import { SEARCH_SHARD_SCHEMA_VERSION } from "./search-shards.js";
import { assertNoSymlinkTraversal, readText, toPosix } from "./util.js";

export const MIGRATION_REPORT_SCHEMA_VERSION = 1;

export async function migrateProject(root, options = {}) {
  const write = options.write === true;
  const { config } = await loadConfig(root);
  const before = await inspectGeneratedFormats(root, config);
  const plan = await generateProject(root, {
    check: true,
    incremental: false,
    lockOptions: options.lockOptions,
    renameOptions: options.renameOptions,
  });
  const required = plan.changedFiles.length > 0 || before.some((format) => format.status !== "current");
  const blocked = plan.counts.error > 0;

  if (!write || blocked || !required) {
    return {
      schemaVersion: MIGRATION_REPORT_SCHEMA_VERSION,
      ok: !blocked && !required,
      mode: write ? "write" : "check",
      required,
      applied: false,
      changedFiles: plan.changedFiles,
      formats: before,
      diagnostics: plan.diagnostics,
      transaction: plan.transaction,
    };
  }

  const applied = await generateProject(root, {
    check: false,
    incremental: false,
    failpoint: options.failpoint,
    lockOptions: options.lockOptions,
    renameOptions: options.renameOptions,
    onTransactionPhase: options.onTransactionPhase,
  });
  const after = applied.ok ? await inspectGeneratedFormats(root, config) : before;
  return {
    schemaVersion: MIGRATION_REPORT_SCHEMA_VERSION,
    ok: applied.ok && after.every((format) => format.status === "current"),
    mode: "write",
    required,
    applied: applied.ok,
    changedFiles: plan.changedFiles,
    formats: after,
    previousFormats: before,
    diagnostics: applied.diagnostics,
    transaction: applied.transaction,
  };
}

async function inspectGeneratedFormats(root, config) {
  const cacheDirectory = toPosix(config.generation.cacheDirectory).replace(/\/+$/u, "");
  const cacheRoot = path.join(root, cacheDirectory);
  await assertNoSymlinkTraversal(root, cacheRoot, cacheDirectory);
  const repositoryId = config.repositoryId;
  const records = [];

  const index = await inspectJson(root, path.join(cacheRoot, "index.json"), `${cacheDirectory}/index.json`);
  records.push(formatRecord(
    "primary-index",
    `${cacheDirectory}/index.json`,
    index,
    (value) => value?.schemaVersion === 1 && value.repositoryId === repositoryId && Array.isArray(value.cards),
    "schemaVersion 1",
  ));

  const search = await inspectJson(root, path.join(cacheRoot, "search-index.json"), `${cacheDirectory}/search-index.json`);
  records.push(formatRecord(
    "search-index",
    `${cacheDirectory}/search-index.json`,
    search,
    (value) => isCompatibleSearchIndex(value, repositoryId),
    `schemaVersion ${SEARCH_INDEX_SCHEMA_VERSION} ${SEARCH_INDEX_ENCODING}`,
  ));

  const fileState = await inspectJson(root, path.join(cacheRoot, "file-state.json"), `${cacheDirectory}/file-state.json`);
  records.push(formatRecord(
    "file-state",
    `${cacheDirectory}/file-state.json`,
    fileState,
    usableFileState,
    `schemaVersion ${FILE_STATE_SCHEMA_VERSION} indexerVersion ${SOURCE_INDEXER_VERSION}`,
  ));

  const graph = await inspectJson(root, path.join(cacheRoot, "graph.json"), `${cacheDirectory}/graph.json`);
  records.push(formatRecord(
    "repository-graph",
    `${cacheDirectory}/graph.json`,
    graph,
    (value) => isCompatibleRepositoryGraph(value, repositoryId),
    `schemaVersion ${GRAPH_SCHEMA_VERSION}`,
  ));

  const graphState = await inspectJson(root, path.join(cacheRoot, "graph-state.json"), `${cacheDirectory}/graph-state.json`);
  records.push(formatRecord(
    "graph-state",
    `${cacheDirectory}/graph-state.json`,
    graphState,
    (value) => compatibleGraphState(value, repositoryId),
    `schemaVersion ${GRAPH_STATE_SCHEMA_VERSION}`,
  ));

  const prompt = await inspectJson(root, path.join(cacheRoot, "prompt-prefix.json"), `${cacheDirectory}/prompt-prefix.json`);
  records.push(formatRecord(
    "prompt-prefix",
    `${cacheDirectory}/prompt-prefix.json`,
    prompt,
    (value) => isCompatiblePromptPrefixBundle(value, repositoryId),
    `schemaVersion ${PROMPT_BUNDLE_SCHEMA_VERSION}`,
  ));

  const manifest = await inspectJson(root, path.join(cacheRoot, "manifest.json"), `${cacheDirectory}/manifest.json`);
  records.push(formatRecord(
    "manifest",
    `${cacheDirectory}/manifest.json`,
    manifest,
    (value) => compatibleManifest(value, repositoryId),
    "schemaVersion 1 with current generated format versions",
  ));

  return records;
}

function compatibleManifest(value, repositoryId) {
  return Boolean(
    value &&
      value.schemaVersion === 1 &&
      value.repositoryId === repositoryId &&
      value.fileStateSchemaVersion === FILE_STATE_SCHEMA_VERSION &&
      value.searchIndexSchemaVersion === SEARCH_INDEX_SCHEMA_VERSION &&
      value.graphSchemaVersion === GRAPH_SCHEMA_VERSION &&
      value.graphStateSchemaVersion === GRAPH_STATE_SCHEMA_VERSION &&
      value.promptBundleSchemaVersion === PROMPT_BUNDLE_SCHEMA_VERSION &&
      (value.searchShardSchemaVersion === null || value.searchShardSchemaVersion === SEARCH_SHARD_SCHEMA_VERSION) &&
      value.files && typeof value.files === "object",
  );
}

async function inspectJson(root, filePath, label) {
  await assertNoSymlinkTraversal(root, filePath, label);
  const text = await readText(filePath, null);
  if (text === null) return { state: "missing", value: null, detail: "file is missing" };
  try {
    return { state: "present", value: JSON.parse(text), detail: null };
  } catch (error) {
    return { state: "malformed", value: null, detail: error instanceof Error ? error.message : String(error) };
  }
}

function formatRecord(id, relativePath, inspected, compatible, expected) {
  if (inspected.state === "missing") return { id, path: relativePath, status: "missing", expected, detail: inspected.detail };
  if (inspected.state === "malformed") return { id, path: relativePath, status: "incompatible", expected, detail: inspected.detail };
  const current = compatible(inspected.value);
  return {
    id,
    path: relativePath,
    status: current ? "current" : "incompatible",
    expected,
    detail: current ? null : describeVersion(inspected.value),
  };
}

function describeVersion(value) {
  if (!value || typeof value !== "object") return "expected a JSON object";
  const fields = ["schemaVersion", "indexerVersion", "encoding", "tokenizerVersion"]
    .filter((name) => value[name] !== undefined)
    .map((name) => `${name}=${JSON.stringify(value[name])}`);
  return fields.length > 0 ? `found ${fields.join(" ")}` : "version fields are missing";
}
