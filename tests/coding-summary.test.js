import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCoding } from "../benchmarks/coding-summary.js";

function fixture() {
  const make = (task, input, cached) => ({ task, condition: "baseline", language: "go", success: true,
    scopePassed: true, conditionAdhered: true, elapsedMs: 100, trace: { tools: [], usage: { input_tokens: input, cached_input_tokens: cached }, uncachedInputTokens: input - cached } });
  return { complete: true, preflight: { writePassed: true, llmnavPassed: true, serenaPassed: true },
    corpora: [{ originalsUnchanged: true }], methodology: { conditions: ["baseline"] },
    controls: ["one", "two"].map(task => ({ task, pristine: { passed: true }, mutant: { passed: false, timedOut: false } })),
    rows: [make("one", 100, 90), make("two", 10, 0)] };
}

test("coding summary aggregates cache counters before taking a ratio and retains failed attempts", () => {
  const report = fixture();
  report.rows[1].success = false;
  report.rows[1].timedOut = true;
  const [result] = summarizeCoding(report);
  assert.equal(result.successes, 1);
  assert.equal(result.attempts, 2);
  assert.equal(result.timeouts, 1);
  assert.equal(result.uncachedInputTokens, 20);
  assert.equal(result.cacheShare, 90 / 110);
  delete report.rows[1].trace.usage.cached_input_tokens;
  assert.equal(summarizeCoding(report)[0].cacheShare, null);
});

test("coding summary refuses incomplete, duplicate, or environmentally excluded evidence", () => {
  const incomplete = fixture(); incomplete.complete = false;
  assert.throws(() => summarizeCoding(incomplete), /Incomplete/u);
  const excluded = fixture(); excluded.validForComparison = false;
  assert.throws(() => summarizeCoding(excluded), /excluded/u);
  const duplicate = fixture(); duplicate.rows[1] = duplicate.rows[0];
  assert.throws(() => summarizeCoding(duplicate), /duplicate/u);
  const failedPreflight = fixture(); failedPreflight.preflight.llmnavPassed = false;
  assert.throws(() => summarizeCoding(failedPreflight), /preflight/u);
  const unknownMutant = fixture(); delete unknownMutant.controls[0].mutant.passed;
  assert.throws(() => summarizeCoding(unknownMutant), /controls/u);
});
