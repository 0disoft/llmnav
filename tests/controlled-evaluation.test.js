import assert from "node:assert/strict";
import test from "node:test";
import { codingCases, mutateSource } from "../benchmarks/coding-cases.js";
import { serenaCandidates } from "../benchmarks/serena-navigation.js";
import { summarizeTrace } from "../benchmarks/model-coding.js";

test("Serena locations normalize Windows paths and zero-based physical lines", () => {
  assert.deepEqual(serenaCandidates(JSON.stringify([{ relative_path: "src\\entry.ts", name_path: "find",
    body_location: { start_line: 0, end_line: 4 } }])), [{ path: "src/entry.ts", line: 1, symbol: "find" }]);
  assert.throws(() => serenaCandidates('{"message":"too many matches"}'), /array/u);
  assert.throws(() => serenaCandidates('[{"relative_path":"a"}]'), /location/u);
});

test("coding traces measure completed tools and cache counters without retaining model content", () => {
  const stdout = [
    { type: "item.completed", item: { type: "reasoning", text: "private reasoning canary" } },
    { type: "item.started", item: { type: "mcp_tool_call", tool: "find_symbol" } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "eval_nav", tool: "find_symbol", status: "completed", result: { text: "body canary" } } },
    { type: "item.completed", item: { type: "command_execution", command: "private command canary", exit_code: 0, aggregated_output: "output canary" } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 9 } },
  ].map(item => JSON.stringify(item)).join("\n");
  const trace = summarizeTrace(stdout);
  assert.equal(trace.tools.length, 2);
  assert.equal(trace.uncachedInputTokens, 30);
  assert.equal(trace.completed, true);
  assert.equal(JSON.stringify(trace).includes("canary"), false);
  assert.equal(summarizeTrace('{"type":"turn.failed"}').completed, false);
  assert.equal(summarizeTrace('{"type":"turn.completed","usage":{"input_tokens":12}}').uncachedInputTokens, null);
  const denial = summarizeTrace(JSON.stringify({ type: "item.completed", item: {
    type: "mcp_tool_call", tool: "llmnav_discover", status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" },
  } }));
  assert.equal(denial.tools[0].toolError, true);
  assert.equal(denial.tools[0].errorCategory, "approval_required");
  const semantic = summarizeTrace(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: 'npm exec -- llmnav discover example' } }));
  assert.equal(semantic.tools[0].semanticCliMentioned, true);
});

test("eight balanced coding mutations reject missing or ambiguous source anchors", () => {
  assert.equal(codingCases.filter(item => item.language === "typescript").length, 4);
  assert.equal(codingCases.filter(item => item.language === "go").length, 4);
  assert.equal(new Set(codingCases.map(item => item.id)).size, 8);
  for (const task of codingCases) {
    assert.equal(mutateSource(task.before, task), task.after);
    assert.throws(() => mutateSource("", task), /unique/u);
    assert.throws(() => mutateSource(task.before + task.before, task), /unique/u);
  }
});
