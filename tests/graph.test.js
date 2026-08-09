import assert from "node:assert/strict";
import test from "node:test";
import { buildRepositoryGraph } from "../src/graph.js";

test("builds deterministic graph edges with provenance and confidence", () => {
  const cards = [
    card("auth.session.rotate", "src/auth/rotate.ts", ["test>auth.session.rotate-contract"], ["./contract.js"]),
    card("auth.session.rotate-contract", "src/auth/contract.ts"),
  ];
  const project = {
    graphInputs: [{
      file: ".llmnav/imports/payments.json",
      contentHash: "abc",
      schemaVersion: 1,
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
  const index = { repositoryId: "llmnav-fixture", cards };
  const graph = buildRepositoryGraph(project, index);
  const repeated = buildRepositoryGraph(project, index);
  assert.deepEqual(repeated, graph);
  assert.equal(graph.schemaVersion, 1);
  assert.equal(graph.stats.nodeCount, 3);
  assert.equal(graph.stats.edgeCount, 3);
  assert.deepEqual(
    Object.fromEntries(graph.edges.map((edge) => [edge.kind, [edge.confidence, edge.provenance.type]])),
    {
      imports: [0.85, "local-import"],
      test: [1, "source-card"],
      calls: [0.9, "generated-index"],
    },
  );
  assert.ok(graph.edges.every((edge) => /^[a-f0-9]{64}$/u.test(edge.id)));
  assert.equal(graph.nodes.find((node) => node.key === "payments/billing.capture.run").external, true);
});

function card(id, file, rel = [], imports = []) {
  return {
    id,
    role: `Own ${id}.`,
    rel,
    imports,
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
