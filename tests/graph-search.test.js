import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { buildInvertedIndex } from "../src/inverted-index.js";
import { buildContext, queryPreparedIndex, showProjectCard } from "../src/search.js";

test("adds confidence-weighted graph neighbors without replacing lexical seeds", () => {
  const index = {
    schemaVersion: 1,
    repositoryId: "graph-search",
    cards: [
      indexedCard("auth.session.rotate", "Rotate a refresh credential atomically."),
      indexedCard("auth.session.revoke", "Revoke the token family after replay."),
    ],
  };
  const searchIndex = buildInvertedIndex(index).searchIndex;
  const graph = {
    schemaVersion: 1,
    repositoryId: "graph-search",
    sourceHash: "fixture",
    nodes: [],
    edges: [{
      id: "edge-1",
      from: "graph-search/auth.session.rotate",
      to: "graph-search/auth.session.revoke",
      kind: "calls",
      confidence: 0.75,
      provenance: { type: "generated-index", source: "fixture.json", path: null, line: null, generator: "fixture" },
    }],
  };
  const withoutGraph = queryPreparedIndex(index, searchIndex, "rotate refresh credential", { top: 5 });
  const metrics = {};
  const withGraph = queryPreparedIndex(index, searchIndex, "rotate refresh credential", { top: 5, graph, metrics });
  assert.equal(withoutGraph.some((item) => item.id === "auth.session.revoke"), false);
  assert.equal(withGraph[0].id, "auth.session.rotate");
  assert.ok(withGraph.some((item) => item.id === "auth.session.revoke" && item.reasons.includes("graph-out:calls@0.75")));
  assert.equal(metrics.graphEdgesVisited, 1);
});

test("packs graph neighbors and edge evidence within explicit bounds", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-graph-context-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"graph-context"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "auth.ts"), `${sourceCard("auth.session.rotate", "rotateSession")}\n${sourceCard("auth.session.revoke", "revokeSession")}\n`);
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
  await mkdir(path.join(root, ".llmnav", "imports"), { recursive: true });
  await writeFile(path.join(root, ".llmnav", "imports", "graph.json"), `${JSON.stringify({
    schemaVersion: 1,
    repositoryId: "graph-context",
    definitions: [{ id: "other/external.capability", symbol: "externalCapability", path: "src/external.ts", line: 7, kind: "function" }],
    references: [{ from: "auth.session.rotate", to: "auth.session.revoke", kind: "calls", confidence: 0.9 }],
  }, null, 2)}\n`);
  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.graph.indexFiles = [".llmnav/imports/graph.json"];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const generated = await generateProject(root);
  assert.equal(generated.ok, true);

  const packed = await buildContext(root, "auth.session.rotate", { depth: 1, budget: 2500, maxEdges: 1 });
  assert.deepEqual(packed.included, ["auth.session.rotate", "auth.session.revoke"]);
  assert.equal(packed.includedEdges.length, 1);
  assert.match(packed.text, /graph graph-context\/auth\.session\.rotate -\[calls confidence=0\.90 provenance=generated-index\]-> graph-context\/auth\.session\.revoke/u);

  const external = await showProjectCard(root, "external.capability");
  assert.equal(external.card, null);
  assert.equal(external.node.key, "other/external.capability");
  const externalContext = await buildContext(root, "other/external.capability", { depth: 0, budget: 500, maxEdges: 0 });
  assert.deepEqual(externalContext.included, ["other/external.capability"]);
  assert.match(externalContext.text, /def externalCapability src\/external\.ts:7 kind=function/u);
});

function indexedCard(id, role) {
  return {
    id,
    role,
    search: [],
    owns: [],
    excludes: [],
    invariant: [],
    effect: [],
    risk: [],
    rel: [],
    stability: "contract",
    imports: [],
    boundaries: [],
    location: { path: "src/auth.ts", startLine: 1, endLine: 1, symbol: null, kind: null, declarationLine: null, signature: null },
    hashes: { semantic: id, structure: id, body: id },
  };
}

test("legacy context respects edge limits when the graph is missing or malformed", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-legacy-context-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"legacy-context"}\n');
  await mkdir(path.join(root, "src"));
  const cards = [
    sourceCard("auth.session.rotate", "rotateSession").replace("stability=contract", "rel=workflow>auth.session.revoke\nrel=test>auth.session.verify\nstability=contract"),
    sourceCard("auth.session.revoke", "revokeSession"),
    sourceCard("auth.session.verify", "verifySession"),
  ];
  await writeFile(path.join(root, "src", "auth.ts"), cards.join("\n"));
  assert.equal((await initializeProject(root, { agents: ["none"] })).ok, true);
  const graphPath = path.join(root, ".llmnav", "cache", "graph.json");
  for (const malformed of [false, true]) {
    if (malformed) await writeFile(graphPath, "{");
    else await rm(graphPath);
    assert.deepEqual((await buildContext(root, "auth.session.rotate", { depth: 8, maxEdges: 0 })).included, ["auth.session.rotate"]);
    assert.equal((await buildContext(root, "auth.session.rotate", { depth: 8, maxEdges: 1 })).included.length, 2);
    assert.deepEqual((await buildContext(root, "auth.session.revoke", { depth: 8, maxEdges: 0 })).included, ["auth.session.revoke"]);
    assert.equal((await buildContext(root, "auth.session.revoke", { depth: 8, maxEdges: 1 })).included.length, 2);
  }
});

function sourceCard(id, symbol) {
  return `/* llmnav/1 symbol\nid=${id}\nrole=Execute ${id} deterministically.\nsearch=${id.replaceAll(".", " ")}|session contract\nstability=contract\n*/\nexport function ${symbol}(): void {}`;
}
