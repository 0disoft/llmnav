# Provider-neutral host integration

LLMNav exposes repository navigation contracts without choosing a model provider, transport, tool-call event shape, or cache-control header.

## Bind authority outside model input

The host chooses one repository root and closes over it. The model never receives a `root` field in a tool schema and cannot redirect a call to another checkout.

```js
import { createLlmnavHost } from "llmnav/examples/provider-neutral-host.mjs";

const host = await createLlmnavHost(process.cwd());
```

The packaged example returns fixed tool definitions, verified prompt partitions, and one executor. Copy the small adapter into a host when its packaging system does not import example files directly.

## Register tools

Pass `host.toolDefinitions` through the provider SDK's tool-definition mapping without changing names, descriptions, input properties, required fields, or order. Provider-specific wrapper keys may differ; the nested LLMNav JSON Schemas stay unchanged.

When a tool call arrives:

```js
const result = await host.execute({
  name: call.name,
  input: call.arguments,
});
```

Return the complete result envelope to the model. Do not convert an expected `LNVAP002` or `LNVAP404` result into an uncaught transport failure.

## Assemble a cacheable prefix

```js
const base = host.basePromptPartitions;
const selected = host.selectPromptPartitions(["auth.session"]);
```

`basePromptPartitions` contains package tool definitions, the agent protocol, and the repository core in declared order. The selected form appends requested module partitions in bundle order. A missing module fails explicitly instead of silently dropping context.

Map each partition's `cacheBoundaryAfter` hint to the provider's cache-control mechanism only when that mechanism exists. Append user requests, branch state, diffs, source bodies, and tool results after all selected LLMNav partitions. Never store those volatile values back into `prompt-prefix.json`.

## Minimal host loop

```js
const host = await createLlmnavHost(repositoryRoot);
const request = {
  tools: mapToolDefinitions(host.toolDefinitions),
  prefix: mapPromptPartitions(host.basePromptPartitions),
  messages: currentMessages,
};

const response = await provider.generate(request);
for (const call of extractToolCalls(response)) {
  const result = await host.execute({ name: call.name, input: call.arguments });
  currentMessages.push(mapToolResult(call, result));
}
```

`mapToolDefinitions`, `mapPromptPartitions`, `extractToolCalls`, and `mapToolResult` are intentionally host-owned. This keeps provider churn outside the LLMNav contract and makes it possible to test the navigation adapter without network access or model credentials.

## Editor diagnostics

Headless hosts can call the `llmnav_check` operation. Editor hosts that need document ranges should run `llmnav check --format editor` or call `diagnosticsToEditor`; see [Editor integration](editor-integration.md).
