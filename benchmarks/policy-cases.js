// Fixed, author-curated regressions in real LLMNav production code, not holdouts.
export const policyCases = [
  {
    id: "source-budget", language: "javascript",
    prompt: "Repair inconsistent source-excerpt budget enforcement across the public JavaScript API, provider-neutral/MCP tools, and CLI. " +
      "The policy is 256..16000 integer UTF-8 source bytes, default 4000; JSON metadata is additional. " +
      "An explicit CLI budget must reach discovery, invalid budgets must be rejected consistently, " +
      "and the schema must advertise the same limits. Preserve Unicode, aggregate budgets across candidates, " +
      "default output, ranking, cancellation and existing public signatures. Locate and repair every affected layer.",
    mutations: [
      ["src/discovery.js", "sourceBudget < DISCOVERY_SOURCE_LIMITS.minimum", "sourceBudget < 1"],
      ["src/agent-tools.js", "DISCOVERY_SOURCE_LIMITS.minimum, DISCOVERY_SOURCE_LIMITS.maximum, DISCOVERY_SOURCE_LIMITS.default", "1, DISCOVERY_SOURCE_LIMITS.maximum, DISCOVERY_SOURCE_LIMITS.default"],
      ["src/cli.js", 'sourceBudget: parseCliIntegerOption(args, "--source-budget", undefined)', "sourceBudget: undefined"],
    ],
  },
  {
    id: "zero-edge-cap", language: "javascript",
    prompt: "Repair context edge-limit handling across the CLI and provider-neutral/MCP operations. " +
      "An explicit maxEdges:0 / --max-edges 0 means include the root boundary only, inspect no relationships, " +
      "and report maxEdges:0. It must not become the default 24. An omitted limit keeps the current default, " +
      "positive limits still work, and the policy must hold with a generated repository graph and with the " +
      "legacy card-only fallback, through project and session operation paths. Preserve depth, budget, " +
      "invalid-input errors and public signatures. Locate and repair every affected layer.",
    mutations: [
      ["src/agent-protocol.js", "maxEdges: input.maxEdges ?? SEARCH_LIMITS.maxEdges.default", "maxEdges: input.maxEdges || SEARCH_LIMITS.maxEdges.default"],
      ["src/cli.js", 'maxEdges: parseCliIntegerOption(args, "--max-edges", SEARCH_LIMITS.maxEdges.default)', "maxEdges: SEARCH_LIMITS.maxEdges.default"],
    ],
  },
];

export function applyPolicyMutation(text, before, after) {
  if (text.split(before).length !== 2) throw new Error("Mutation anchor must occur exactly once.");
  return text.replace(before, after);
}
