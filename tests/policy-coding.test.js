import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { policyCases, applyPolicyMutation } from "../benchmarks/policy-cases.js";
import { normalizeRepairPatch, policyModelArguments, snapshotChanges, summarizePolicy } from "../benchmarks/policy-coding.js";

function fixture() {
  return { complete: true, originalsUnchanged: true, conditions: ["baseline", "llmnav"], repetitions: 1,
    preflight: { writePassed: true, llmnavPassed: true },
    controls: policyCases.map(task => ({ task: task.id, pristine: { passed: true }, mutant: { passed: false } })),
    rows: policyCases.flatMap(task => ["baseline", "llmnav"].map(condition => ({ task: task.id, condition, repetition: 0,
      success: true, acceptance: { passed: true }, scopePassed: true, conditionAdhered: true, navigationUsed: false,
      timedOut: false, elapsedMs: 100, trace: { tools: [], usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 }, uncachedInputTokens: 20 } }))) };
}

test("policy evidence includes failures and aggregates source token counters", () => {
  const report = fixture();
  report.rows[2].success = false;
  report.rows[2].timedOut = true;
  const [summary] = summarizePolicy(report);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.successes, 1);
  assert.equal(summary.timeouts, 1);
  assert.equal(summary.uncachedInputTokens, 40);
  assert.equal(summary.cacheShare, 0.8);
  delete report.rows[2].trace.usage.cached_input_tokens;
  assert.equal(summarizePolicy(report)[0].cacheShare, null);
});

test("policy summaries reject incomplete cohorts, unknown controls and duplicate attempts", () => {
  const incomplete = fixture(); incomplete.complete = false;
  assert.throws(() => summarizePolicy(incomplete), /Incomplete/u);
  const unknown = fixture(); delete unknown.controls[0].mutant.passed;
  assert.throws(() => summarizePolicy(unknown), /controls/u);
  const missing = fixture(); missing.rows.pop();
  assert.throws(() => summarizePolicy(missing), /Missing/u);
  const duplicate = fixture(); duplicate.rows[1] = duplicate.rows[0];
  assert.throws(() => summarizePolicy(duplicate), /Duplicate/u);
});

test("repair snapshots detect additions and deletions, and mutations require unique anchors", () => {
  assert.deepEqual(snapshotChanges([{ path: "a", hash: "1" }, { path: "b", hash: "2" }],
    [{ path: "b", hash: "3" }, { path: "c", hash: "4" }]), ["a", "b", "c"]);
  assert.equal(applyPolicyMutation("abc", "b", "x"), "axc");
  assert.throws(() => applyPolicyMutation("abc", "missing", "x"), /exactly once/u);
  assert.throws(() => applyPolicyMutation("bb", "b", "x"), /exactly once/u);
});

test("policy trials bind the copied engine and expose only the compared navigation tools", () => {
  const args = policyModelArguments("/corpus", "llmnav", policyCases[0], { engine: "/engine", model: "probe" });
  const definitions = args.filter(value => value.startsWith("mcp_servers.eval_nav."));
  assert.equal(definitions.filter(value => value.startsWith("mcp_servers.eval_nav.args=")).length, 1);
  assert.ok(definitions.some(value => value.includes("llmnav_query") && value.includes("llmnav_context")));
  const serverArgs = JSON.parse(definitions.find(value => value.startsWith("mcp_servers.eval_nav.args=")).split("=").slice(1).join("="));
  assert.deepEqual(serverArgs, [path.join("/engine", "bin/llmnav.js"), "mcp", "--root", "/corpus"]);
  assert.equal(policyModelArguments("/corpus", "baseline", policyCases[0], { model: "probe" })
    .some(value => value.startsWith("mcp_servers.")), false);
});

test("repair patches remove quoted Windows and POSIX header paths without changing the hunk", () => {
  for (const header of ['"C:\\\\Users\\\\canary\\\\source.js"', "/private/canary/source.js"]) {
    const hunk = "@@ -1 +1 @@\n-old\n+new\n";
    const diff = `diff --git ${header} ${header}\nindex a..b 100644\n--- ${header}\n+++ ${header}\n${hunk}`;
    const normalized = normalizeRepairPatch(diff, "src/source.js");
    assert.equal(normalized.includes("canary"), false);
    assert.ok(normalized.startsWith("diff --git a/src/source.js b/src/source.js\n"));
    assert.ok(normalized.endsWith(hunk));
  }
});
