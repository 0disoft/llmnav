/* llmnav/1 module
id=llmnav.agent.provider-neutral-host
role=Demonstrate a provider-neutral host that binds one trusted repository root to reusable LLMNav tools and prompt partitions.
owns=host-side root binding|project session lifecycle|prompt partition selection
excludes=model provider client|authentication|model-selected repository roots
search=provider neutral host|tool call adapter|project session example
invariant=The host supplies the repository root; model-generated tool input cannot replace it.
rel=workflow>llmnav.agent.protocol
stability=contract
*/

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
