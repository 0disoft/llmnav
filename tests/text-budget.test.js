import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { approximateTokens, truncateToTokenBudget } from "../src/util.js";

const LONG = "export function reserveCredits(user: { role: string }) { return user.role === \"admin\"; }\n".repeat(20);

test("token estimates preserve ASCII boundaries and UTF-16 units for Unicode", () => {
  for (const [value, expected] of [
    ["", 1], ["aaaa", 1], ["aaaaa", 2], ["\u007f".repeat(4), 1],
    ["\u0080".repeat(4), 3], ["한글", 2], ["😀", 2], ["abc한😀", 3],
    ["\ud800", 1], ["\udc00", 1], ["a\ud800b", 2],
  ]) assert.equal(approximateTokens(value), expected, JSON.stringify(value));
});

test("large token estimation and budget trimming fit in a bounded child heap", () => {
  const util = new URL("../src/util.js", import.meta.url).href;
  const script = `import assert from "node:assert/strict";
    import { approximateTokens, truncateToTokenBudget } from ${JSON.stringify(util)};
    const source = Buffer.alloc(4 * 1024 * 1024, 97).toString("utf8");
    assert.equal(approximateTokens(source), 1048576);
    const trimmed = truncateToTokenBudget(source, 128);
    assert.ok(approximateTokens(trimmed) <= 128);
    assert.ok(trimmed.endsWith("\\n…"));`;
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("budgeted truncation stays within the budget it is given", () => {
  for (const budget of [1, 2, 3, 5, 8, 16, 32, 64]) {
    const trimmed = truncateToTokenBudget(LONG, budget);
    assert.ok(approximateTokens(trimmed) <= budget, `budget ${budget} produced ${approximateTokens(trimmed)} tokens`);
    assert.ok(trimmed.endsWith("\n…"));
    assert.ok(LONG.startsWith(trimmed.slice(0, -2).trimEnd()));
  }
});

test("budgeted truncation leaves text that already fits untouched", () => {
  const value = "export function reserveCredits() { return 1; }";
  assert.equal(truncateToTokenBudget(value, approximateTokens(value)), value);
  assert.equal(truncateToTokenBudget(value, 1000), value);
  assert.equal(truncateToTokenBudget(LONG, 0), "");
  assert.equal(truncateToTokenBudget(LONG, -5), "");
});

test("budgeted truncation never splits a surrogate pair", () => {
  const value = "😀".repeat(40);
  for (const budget of [1, 2, 3, 6, 10]) {
    const trimmed = truncateToTokenBudget(value, budget);
    assert.equal(trimmed.isWellFormed(), true, `budget ${budget} produced a lone surrogate`);
  }
});
