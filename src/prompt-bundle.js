/* llmnav/1 module
id=llmnav.agent.prompt-bundle
role=Assemble deterministic prompt-prefix partitions with explicit cache scope and integrity hashes.
owns=prompt bundle schema|partition ordering|cache boundaries|bundle integrity
excludes=provider cache API calls|volatile task context|source discovery
search=prompt prefix bundle|cache breakpoint|stable prompt partition|context assembly
rel=workflow>llmnav.agent.tool-schema
rel=workflow>llmnav.agent.install
rel=workflow>llmnav.index.generate
stability=architecture
*/

import path from "node:path";
import { loadConfig } from "./config.js";
import { approximateTokens, assertNoSymlinkTraversal, compareText, readText, sha256, stableJson, stableStringify, toPosix } from "./util.js";

export const PROMPT_BUNDLE_SCHEMA_VERSION = 1;

export function buildPromptPrefixBundle(input) {
  const modules = [...(input.modules ?? [])].sort((left, right) => compareText(left.id, right.id));
  const partitions = [
    partition("package:tool-definitions", "package", "application/json", stableStringify(input.toolDefinitions)),
    partition("package:agent-protocol", "package", "text/markdown", input.agentProtocol),
    partition("repository:core", "repository", "text/plain", input.repositoryCore),
    ...modules.map((item) => partition(`module:${item.id}`, "module", "text/plain", item.content)),
  ];
  const basePartitionIds = partitions.filter((item) => item.cacheScope !== "module").map((item) => item.id);
  const modulePartitionIds = partitions.filter((item) => item.cacheScope === "module").map((item) => item.id);
  const bundleHash = sha256(stableJson(partitions.map((item) => [item.id, item.contentHash])));
  return {
    schemaVersion: PROMPT_BUNDLE_SCHEMA_VERSION,
    repositoryId: input.repositoryId,
    bundleHash,
    assembly: {
      basePartitionIds,
      modulePartitionIds,
      volatileContextAfter: true,
    },
    partitions,
  };
}

export function renderPromptPrefixBundle(bundle) {
  return stableStringify(bundle);
}

export function isCompatiblePromptPrefixBundle(bundle, repositoryId = undefined) {
  if (!bundle || bundle.schemaVersion !== PROMPT_BUNDLE_SCHEMA_VERSION || typeof bundle.repositoryId !== "string" ||
    typeof bundle.bundleHash !== "string" || !bundle.assembly || !Array.isArray(bundle.partitions)) return false;
  if (repositoryId !== undefined && bundle.repositoryId !== repositoryId) return false;
  if (!Array.isArray(bundle.assembly.basePartitionIds) || !Array.isArray(bundle.assembly.modulePartitionIds) ||
    bundle.assembly.volatileContextAfter !== true) return false;
  if (new Set(bundle.partitions.map((item) => item.id)).size !== bundle.partitions.length) return false;
  if (!bundle.partitions.every(validPartition)) return false;
  const base = bundle.partitions.filter((item) => item.cacheScope !== "module").map((item) => item.id);
  const modules = bundle.partitions.filter((item) => item.cacheScope === "module").map((item) => item.id);
  if (stableJson(base) !== stableJson(bundle.assembly.basePartitionIds) ||
    stableJson(modules) !== stableJson(bundle.assembly.modulePartitionIds)) return false;
  return bundle.bundleHash === sha256(stableJson(bundle.partitions.map((item) => [item.id, item.contentHash])));
}

export async function loadPromptPrefixBundle(root) {
  const { config } = await loadConfig(root);
  const relativePath = `${toPosix(config.generation.cacheDirectory).replace(/\/+$/u, "")}/prompt-prefix.json`;
  const bundlePath = path.join(root, relativePath);
  const manifestPath = path.join(root, config.generation.cacheDirectory, "manifest.json");
  await assertNoSymlinkTraversal(root, bundlePath, relativePath);
  await assertNoSymlinkTraversal(root, manifestPath, `${config.generation.cacheDirectory}/manifest.json`);
  const content = await readText(bundlePath, "");
  if (!content) throw new Error(`Missing generated prompt bundle ${relativePath}.`);
  let bundle;
  try {
    bundle = JSON.parse(content);
  } catch {
    throw new Error(`Malformed generated prompt bundle ${relativePath}.`);
  }
  if (!isCompatiblePromptPrefixBundle(bundle, config.repositoryId)) {
    throw new Error(`Incompatible generated prompt bundle ${relativePath}.`);
  }
  const manifestContent = await readText(manifestPath, "");
  const manifest = manifestContent ? JSON.parse(manifestContent) : null;
  if (manifest?.files?.[relativePath] !== sha256(content)) throw new Error(`Prompt bundle hash does not match manifest.json.`);
  return bundle;
}

function partition(id, cacheScope, contentType, content) {
  const normalizedContent = String(content).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return {
    id,
    cacheScope,
    contentType,
    contentHash: sha256(normalizedContent),
    estimatedTokens: approximateTokens(normalizedContent),
    cacheBoundaryAfter: true,
    content: normalizedContent,
  };
}

function validPartition(item) {
  return Boolean(
    item &&
      typeof item.id === "string" &&
      ["package", "repository", "module"].includes(item.cacheScope) &&
      typeof item.contentType === "string" &&
      typeof item.content === "string" &&
      typeof item.contentHash === "string" &&
      item.contentHash === sha256(item.content) &&
      Number.isInteger(item.estimatedTokens) &&
      item.estimatedTokens === approximateTokens(item.content) &&
      item.cacheBoundaryAfter === true,
  );
}
