import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../src/initializer.js";
import { buildContext, createProjectSession } from "../src/search.js";

test("root-only context and show defer graph adjacency until expansion, then reuse it", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-context-limits-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), '{"name":"context-limits"}\n');
  await writeFile(path.join(root, "src/routes.js"), Array.from({ length: 100 }, (_, i) =>
    `/* llmnav/1 symbol\nid=route.part${i}\nrole=Handle route part ${i}.\nrel=workflow>route.part${(i + 1) % 100}\nstability=contract\n*/\nexport function part${i}() {}\n`).join("\n"));
  assert.equal((await initializeProject(root, { agents: ["none"] })).ok, true);
  const graph = JSON.parse(await readFile(path.join(root, ".llmnav/cache/graph.json"), "utf8"));
  assert.ok(graph.edges.length >= 100);
  const originalSort = Array.prototype.sort;
  let sortedEdges = 0;
  // Serial within this test file, as in graph-search.test.js; always restore.
  Array.prototype.sort = function (compare) {
    if (typeof this[0]?.from === "string" && typeof this[0]?.to === "string") sortedEdges += this.length;
    return originalSort.call(this, compare);
  };
  try {
    const session = await createProjectSession(root);
    assert.equal(session.show("route.part0").card.id, "route.part0");
    for (const options of [{ depth: 8, maxEdges: 0 }, { depth: 0, maxEdges: 24 }]) {
      const direct = await buildContext(root, "route.part0", options);
      assert.deepEqual(direct.included, ["route.part0"]);
      assert.deepEqual(direct.includedEdges, []);
      assert.deepEqual(session.context("route.part0", options), direct);
    }
    const rootOnlySortedEdges = sortedEdges;
    const expanded = session.context("route.part0", { maxEdges: 1 });
    assert.ok(expanded.included.length > 1);
    assert.equal(expanded.includedEdges.length, 1);
    const afterFirstExpansion = sortedEdges;
    assert.deepEqual(session.context("route.part0", { maxEdges: 1 }), expanded);
    session.query("route.part0");
    context.diagnostic(JSON.stringify({ edges: graph.edges.length, rootOnlySortedEdges,
      firstExpansionSortedEdges: afterFirstExpansion - rootOnlySortedEdges,
      repeatedExpansionSortedEdges: sortedEdges - afterFirstExpansion }));
    assert.equal(rootOnlySortedEdges, 0);
    assert.equal(afterFirstExpansion, graph.edges.length);
    assert.equal(sortedEdges, afterFirstExpansion);
  } finally { Array.prototype.sort = originalSort; }
});
