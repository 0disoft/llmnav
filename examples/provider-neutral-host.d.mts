import type {
  AgentOperationResult,
  AgentToolDefinition,
  PromptPrefixBundle,
  PromptPrefixPartition,
} from "llmnav";

export interface LlmnavHost {
  toolDefinitions: AgentToolDefinition[];
  basePromptPartitions: PromptPrefixPartition[];
  selectPromptPartitions(moduleIds?: string[]): PromptPrefixPartition[];
  execute(call: { name: string; input?: Record<string, unknown> }): Promise<AgentOperationResult>;
}

export function createLlmnavHost(root: string): Promise<LlmnavHost>;
export function selectPromptPartitions(bundle: PromptPrefixBundle, moduleIds?: string[]): PromptPrefixPartition[];
