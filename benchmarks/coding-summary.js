import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, stableStringify } from "../src/util.js";

export function summarizeCoding(report) {
  assert.ok(report.complete === true && (report.validForComparison === undefined || report.validForComparison === true), "Incomplete or excluded coding cohort");
  assert.ok(report.preflight?.writePassed === true && report.preflight.llmnavPassed === true && report.preflight.serenaPassed === true, "Failed tool preflight");
  assert.ok(report.corpora.length > 0 && report.corpora.every(item => item.originalsUnchanged === true), "Unverified original sources");
  assert.ok(report.controls.length > 0 && report.controls.every(item => item.pristine.passed === true && item.mutant.passed === false && item.mutant.timedOut === false), "Invalid oracle controls");
  const tasks = new Set(report.controls.map(item => item.task));
  const conditions = report.methodology.conditions;
  assert.equal(tasks.size, report.controls.length, "Duplicate task control");
  assert.equal(new Set(conditions).size, conditions.length, "Duplicate condition");
  assert.equal(report.rows.length, tasks.size * conditions.length, "Missing coding observations");
  const seen = new Set();
  for (const row of report.rows) {
    const key = `${row.task}/${row.condition}`;
    assert.ok(tasks.has(row.task) && conditions.includes(row.condition) && !seen.has(key), "Unknown or duplicate coding observation");
    seen.add(key);
  }
  const sumKnown = values => values.every(value => Number.isFinite(value) && value >= 0) ? values.reduce((sum, value) => sum + value, 0) : null;
  return conditions.map(condition => {
    const rows = report.rows.filter(row => row.condition === condition);
    const elapsed = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
    const middle = Math.floor(elapsed.length / 2);
    const inputTokens = sumKnown(rows.map(row => row.trace.usage?.input_tokens));
    const cachedInputTokens = sumKnown(rows.map(row => row.trace.usage?.cached_input_tokens));
    return { condition, attempts: rows.length, successes: rows.filter(row => row.success).length,
      languages: [...new Set(rows.map(row => row.language))].map(language => ({ language,
        attempts: rows.filter(row => row.language === language).length,
        successes: rows.filter(row => row.language === language && row.success).length })),
      scopeFailures: rows.filter(row => !row.scopePassed).length, timeouts: rows.filter(row => row.timedOut).length,
      conditionViolations: rows.filter(row => row.conditionAdhered !== true).length,
      navigationSuccesses: condition === "baseline" ? null : rows.filter(row => row.navigationUsed).length,
      toolEvents: rows.reduce((sum, row) => sum + row.trace.tools.length, 0),
      mcpFailures: rows.flatMap(row => row.trace.tools).filter(tool => tool.type === "mcp_tool_call" && (tool.status !== "completed" || tool.toolError)).length,
      medianElapsedMs: elapsed.length % 2 ? elapsed[middle] : (elapsed[middle - 1] + elapsed[middle]) / 2,
      inputTokens, cachedInputTokens, uncachedInputTokens: sumKnown(rows.map(row => row.trace.uncachedInputTokens)),
      cacheShare: inputTokens > 0 && cachedInputTokens !== null && cachedInputTokens <= inputTokens ? cachedInputTokens / inputTokens : null };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  assert.ok(input && output, "Use coding-summary.js <completed-report.json> <summary.json>");
  const text = await readFile(input, "utf8");
  const summary = { schemaVersion: 1, inputHash: sha256(text), conditions: summarizeCoding(JSON.parse(text)) };
  await writeFile(output, stableStringify(summary));
  console.log(JSON.stringify(summary.conditions));
}
