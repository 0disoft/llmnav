import {
  executeAgentOperation,
  createProjectSession,
  getAgentToolDefinitions,
  loadPromptPrefixBundle,
} from "llmnav";

export async function createLlmnavHost(root) {
  let bundle = await loadPromptPrefixBundle(root);
  let session = await createProjectSession(root);
  const host = {
    toolDefinitions: getAgentToolDefinitions(),
    basePromptPartitions: selectPromptPartitions(bundle),
    selectPromptPartitions(moduleIds = []) {
      return selectPromptPartitions(bundle, moduleIds);
    },
    execute(call) {
      return executeAgentOperation(root, call.name, call.input ?? {}, { session });
    },
    async refresh() {
      [bundle, session] = await Promise.all([
        loadPromptPrefixBundle(root),
        createProjectSession(root),
      ]);
      host.basePromptPartitions = selectPromptPartitions(bundle);
      return host;
    },
  };
  return host;
}

export function selectPromptPartitions(bundle, moduleIds = []) {
  const requested = new Set(moduleIds.map((id) => id.startsWith("module:") ? id : `module:${id}`));
  const available = new Set(bundle.assembly.modulePartitionIds);
  const missing = [...requested].filter((id) => !available.has(id)).sort();
  if (missing.length > 0) throw new Error(`Unknown prompt module partition(s): ${missing.join(", ")}.`);
  return bundle.partitions.filter((partition) =>
    bundle.assembly.basePartitionIds.includes(partition.id) || requested.has(partition.id),
  );
}
