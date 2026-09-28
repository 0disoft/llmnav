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
} from "llmnav";

export async function createLlmnavHost(root) {
  let session = await createProjectSession(root, { withPromptBundle: true });
  let bundle = session.promptBundle;
  const host = {
    toolDefinitions: getAgentToolDefinitions(),
    basePromptPartitions: selectPromptPartitions(bundle),
    generationHash: session.generationHash,
    selectPromptPartitions(moduleIds = []) {
      return selectPromptPartitions(bundle, moduleIds);
    },
    execute(call) {
      return executeAgentOperation(root, call.name, call.input ?? {}, { session });
    },
    async refresh() {
      const nextSession = await createProjectSession(root, { withPromptBundle: true });
      const nextBundle = nextSession.promptBundle;
      const nextBase = selectPromptPartitions(nextBundle);
      session = nextSession;
      bundle = nextBundle;
      host.basePromptPartitions = nextBase;
      host.generationHash = nextSession.generationHash;
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
