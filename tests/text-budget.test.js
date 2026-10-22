import assert from "node:assert/strict";
import test from "node:test";
import { approximateTokens, truncateToTokenBudget } from "../src/util.js";

const LONG = "export function reserveCredits(user: { role: string }) { return user.role === \"admin\"; }\n".repeat(20);

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
