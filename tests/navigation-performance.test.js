import assert from "node:assert/strict";
import test from "node:test";
import { runNavigationBenchmark } from "../benchmarks/navigation.js";

test("graph-aware navigation measures isolated phases without changing results", { timeout: 120000 }, async () => {
  const report = await runNavigationBenchmark({ fileCount: 10, cardsPerFile: 10, queryCount: 10, relationsPerCard: 2 });
  assert.equal(report.fixture.cards, 100);
  assert.equal(report.fixture.edges, 200);
  assert.equal(report.correctness.queries, 10);
  assert.equal(report.correctness.contexts, 10);
  assert.equal(report.correctness.exactQueryMatch, true);
  assert.equal(report.correctness.boundedGraphContext, true);
  assert.equal(report.correctness.refreshStable, true);
  assert.ok(report.sessionQuery.work.graphEdgesVisited > 0);
  assert.equal(report.sessionQuery.work.documentTokenizations, 0);
  assert.equal(report.sessionQuery.work.idNormalizations, 0);
  assert.equal(report.sessionQuery.work.lookupBuilds, 0);
  assert.equal(report.sessionQuery.work.graphValidations, 0);
  for (const duration of [report.initialSessionMs, report.firstQueryMs, report.refreshMs, report.sessionQuery.p95Ms, report.sessionContext.p95Ms]) {
    assert.ok(Number.isFinite(duration) && duration >= 0);
  }
  assert.equal(report.environment.filesystemCacheFlushed, false);
});
