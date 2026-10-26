import assert from "node:assert/strict";
import test from "node:test";
import { buildRepositoryGraphIncremental, compatibleGraphState } from "../src/graph.js";

test("reuses content-addressed graph partitions and matches a full rebuild", () => {
  const project = fixtureProject();
  const index = fixtureIndex();
  const first = buildRepositoryGraphIncremental(project, index);
  assert.deepEqual(first.stats, {
    totalPartitions: 3,
    reusedPartitions: 0,
    rebuiltPartitions: 3,
    removedPartitions: 0,
  });
  assert.equal(compatibleGraphState(first.state, "llmnav-fixture"), true);

  const noop = buildRepositoryGraphIncremental(project, index, first.state);
  assert.equal(noop.stats.reusedPartitions, 3);
  assert.equal(noop.stats.rebuiltPartitions, 0);
  assert.deepEqual(noop.graph, first.graph);

  const bodyOnlyIndex = structuredClone(index);
  bodyOnlyIndex.cards[0].hashes.body = "body-b";
  const bodyOnly = buildRepositoryGraphIncremental(project, bodyOnlyIndex, noop.state);
  assert.equal(bodyOnly.stats.reusedPartitions, 3);
  assert.equal(bodyOnly.stats.rebuiltPartitions, 0);

  const semanticIndex = structuredClone(bodyOnlyIndex);
  semanticIndex.cards[0].rel = ["test>auth.session.new-contract"];
  const semantic = buildRepositoryGraphIncremental(project, semanticIndex, bodyOnly.state);
  assert.equal(semantic.stats.reusedPartitions, 2);
  assert.equal(semantic.stats.rebuiltPartitions, 1);
  assert.ok(semantic.graph.nodes.some((node) => node.key === "llmnav-fixture/auth.session.new-contract"));

  const changedInputProject = fixtureProject();
  changedInputProject.graphInputs[0].contentHash = "input-b";
  const changedInput = buildRepositoryGraphIncremental(changedInputProject, semanticIndex, semantic.state);
  assert.equal(changedInput.stats.reusedPartitions, 2);
  assert.equal(changedInput.stats.rebuiltPartitions, 1);

  const removedInput = buildRepositoryGraphIncremental({ graphInputs: [] }, semanticIndex, changedInput.state);
  assert.equal(removedInput.stats.removedPartitions, 1);
  assert.equal(removedInput.stats.reusedPartitions, 2);
  const forced = buildRepositoryGraphIncremental({ graphInputs: [] }, semanticIndex, null);
  assert.deepEqual(removedInput.graph, forced.graph);
  assert.deepEqual(removedInput.state, forced.state);
});

test("rejects malformed graph state instead of reusing it", () => {
  const project = fixtureProject();
  const index = fixtureIndex();
  const malformed = {
    schemaVersion: 1,
    repositoryId: "llmnav-fixture",
    resolutionHash: "bad",
    partitions: [{ key: "card:bad", inputHash: "bad", nodes: [], edges: [{ from: 1 }] }],
  };
  assert.equal(compatibleGraphState(malformed), false);
  assert.equal(buildRepositoryGraphIncremental(project, index, malformed).stats.rebuiltPartitions, 3);
});

test("rebuilds card partitions when local module resolution changes", () => {
  const project = fixtureProject();
  const index = fixtureIndex();
  const first = buildRepositoryGraphIncremental(project, index);
  const changed = buildRepositoryGraphIncremental({
    ...project,
    moduleResolution: {
      schemaVersion: 1,
      goModules: [{ directory: "", modulePath: "example.com/fixture" }],
    },
  }, index, first.state);
  assert.equal(changed.stats.rebuiltPartitions, 2);
  assert.equal(changed.stats.reusedPartitions, 1);
});

test("Go import targets stay identical to full rebuilds across module scope changes", () => {
  const project = {
    moduleResolution: {
      schemaVersion: 1,
      goModules: [{ directory: "", modulePath: "example.com/app" }],
    },
  };
  const index = {
    repositoryId: "go-fixture",
    cards: [
      card("entry.run", "cmd/main.go", [], ["example.com/app/lib"]),
      card("lib.boundary", "lib/boundary.go"),
      card("lib.helper", "lib/helper.go"),
    ],
  };
  for (const item of index.cards) {
    item.scope = "symbol";
    item.location.language = "go";
  }
  const targets = graph => graph.edges.filter(edge => edge.kind === "imports").map(edge => edge.to);
  let previous = buildRepositoryGraphIncremental(project, index);
  assert.deepEqual(targets(previous.graph), ["go-fixture/lib.boundary", "go-fixture/lib.helper"]);

  for (const [scope, expected] of [
    ["module", ["go-fixture/lib.boundary"]],
    ["file", ["go-fixture/lib.boundary", "go-fixture/lib.helper"]],
    ["module", ["go-fixture/lib.boundary"]],
  ]) {
    const changed = structuredClone(index);
    changed.cards[1].scope = scope;
    const full = buildRepositoryGraphIncremental(project, changed);
    const incremental = buildRepositoryGraphIncremental(project, changed, previous.state);
    assert.deepEqual(targets(incremental.graph), expected, `scope=${scope}`);
    assert.deepEqual(incremental.graph, full.graph);
    assert.deepEqual(incremental.state, full.state);
    assert.equal(incremental.stats.rebuiltPartitions, 3);
    const warm = buildRepositoryGraphIncremental(project, changed, incremental.state);
    assert.equal(warm.stats.rebuiltPartitions, 0);
    assert.equal(warm.stats.reusedPartitions, 3);
    const reordered = { ...changed, cards: [...changed.cards].reverse() };
    const shuffled = buildRepositoryGraphIncremental(project, reordered, incremental.state);
    assert.deepEqual(shuffled.graph, full.graph);
    assert.equal(shuffled.stats.rebuiltPartitions, 0);
    previous = incremental;
  }
  const unchangedTargets = structuredClone(index);
  unchangedTargets.cards[1].scope = "module";
  unchangedTargets.cards[2].scope = "file";
  const unchanged = buildRepositoryGraphIncremental(project, unchangedTargets, previous.state);
  assert.deepEqual(unchanged.graph, previous.graph);
  assert.equal(unchanged.stats.reusedPartitions, 3);
});

function fixtureIndex() {
  return {
    repositoryId: "llmnav-fixture",
    cards: [
      card("auth.session.rotate", "src/auth/rotate.ts", ["test>auth.session.rotate-contract"], ["./contract.js"]),
      card("auth.session.rotate-contract", "src/auth/contract.ts"),
    ],
  };
}

function fixtureProject() {
  return {
    graphInputs: [{
      file: ".llmnav/imports/payments.json",
      contentHash: "input-a",
      repositoryId: "payments",
      generator: "scip-adapter@1",
      definitions: [{ id: "payments/billing.capture.run", symbol: "runCapture", path: "src/capture.ts", line: 4, kind: "function" }],
      references: [{
        from: "payments/billing.capture.run",
        to: "llmnav-fixture/auth.session.rotate",
        kind: "calls",
        path: "src/capture.ts",
        line: 9,
        confidence: 0.9,
      }],
    }],
  };
}

function card(id, file, rel = [], imports = []) {
  return {
    id,
    role: `Own ${id}.`,
    rel,
    imports,
    hashes: { semantic: `semantic:${id}`, structure: `structure:${id}`, body: "body-a" },
    location: {
      path: file,
      startLine: 1,
      endLine: 8,
      symbol: id.split(".").at(-1),
      kind: "function",
      declarationLine: 8,
      signature: "export function fixture()",
      language: "typescript",
      exported: true,
      visibility: "public",
      receiver: null,
    },
  };
}
