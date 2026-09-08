import assert from "node:assert/strict";
import test from "node:test";
import { rankEvidence, replayCases } from "../benchmarks/navigation-replay.js";

test("replay evidence deduplicates paths without turning a missing target into a hit", () => {
  assert.deepEqual(rankEvidence(["a", "a", "b"], "b"), {
    candidates: 2, rank: 2, foundAt1: false, foundAt5: true, firstFive: ["a", "b"],
  });
  assert.equal(rankEvidence(["a"], "missing").rank, null);
  assert.equal(rankEvidence(["a"], "missing").foundAt5, false);
  assert.equal(rankEvidence(["a", "b", "c", "d", "e", "f"], "f").foundAt5, false);
  assert.equal(new Set(replayCases.map((item) => item.id)).size, 6);
});
