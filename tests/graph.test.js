import assert from "node:assert/strict";
import test from "node:test";
import { buildRepositoryGraph, resolveGraphNode } from "../src/graph.js";

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

test("resolves qualified and unique workspace IDs while rejecting ambiguity", () => {
  const graph = {
    schemaVersion: 1,
    repositoryId: "local",
    sourceHash: "fixture",
    edges: [],
    nodes: [
      graphNode("local/auth.session.rotate"),
      graphNode("accounts/auth.password.reset"),
      graphNode("payments/billing.capture.run"),
      graphNode("archive/billing.capture.run"),
    ],
  };
  assert.equal(resolveGraphNode(graph, "accounts/auth.password.reset", "local").node.key, "accounts/auth.password.reset");
  assert.equal(resolveGraphNode(graph, "auth.password.reset", "local").node.key, "accounts/auth.password.reset");
  assert.deepEqual(resolveGraphNode(graph, "billing.capture.run", "local").candidates, [
    "archive/billing.capture.run",
    "payments/billing.capture.run",
  ]);
  assert.equal(resolveGraphNode(graph, "billing.capture.run", "local").state, "ambiguous");
});

test("resolves full Go module imports to cards in the imported package", () => {
  const cards = [
    card("gateway.process", "cmd/gatewayd/main.go", [], ["example.com/relay/internal/auth"], {
      language: "go",
      scope: "module",
    }),
    card("auth.boundary", "internal/auth/authenticator.go", [], [], {
      language: "go",
      scope: "module",
    }),
  ];
  const project = {
    graphInputs: [],
    moduleResolution: {
      schemaVersion: 1,
      goModules: [{ directory: "", modulePath: "example.com/relay" }],
    },
  };
  const graph = buildRepositoryGraph(project, { repositoryId: "go-fixture", cards });
  const edge = graph.edges.find((item) => item.kind === "imports");
  assert.equal(edge.from, "go-fixture/gateway.process");
  assert.equal(edge.to, "go-fixture/auth.boundary");
  assert.equal(edge.provenance.type, "local-import");
});

function card(id, file, rel = [], imports = [], options = {}) {
  return {
    id,
    role: `Own ${id}.`,
    scope: options.scope ?? "symbol",
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
      language: options.language ?? "typescript",
      exported: true,
      visibility: "public",
      receiver: null,
    },
  };
}

function graphNode(key) {
  const separator = key.indexOf("/");
  return {
    key,
    repositoryId: key.slice(0, separator),
    semanticId: key.slice(separator + 1),
    role: null,
    location: null,
    external: !key.startsWith("local/"),
    unresolved: false,
    definitions: [{ symbol: "fixture", path: "src/fixture.ts", line: 1, kind: "function", provenance: { type: "generated-index", source: "fixture", generator: "fixture" } }],
  };
}
