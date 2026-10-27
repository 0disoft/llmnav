import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverProject } from "../src/discovery.js";
import { generateProject } from "../src/generator.js";
import { executeAgentOperation } from "../src/agent-protocol.js";
import { sha256 } from "../src/util.js";

async function fixture(context, bytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-graph-snapshot-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav/imports"), { recursive: true });
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "snapshot-fixture", graph: { indexFiles: [".llmnav/imports/code.json"] } }));
  const file = path.join(root, "main.ts");
  await writeFile(file, bytes);
  const graph = { schemaVersion: 2, repositoryId: "snapshot-fixture", generator: "llmnav-typescript@1;compiler=fixture",
    sourceHashes: { "main.ts": sha256(bytes) }, definitions: [{ id: "code.ts.phantom", symbol: "Phantom", path: "main.ts", line: 1, kind: "function" }], references: [] };
  const graphFile = path.join(root, ".llmnav/imports/code.json");
  await writeFile(graphFile, JSON.stringify(graph));
  return { root, file, graph, graphFile };
}

test("scanned-source and compiler snapshots cannot mix in discovery, generation or checks", async context => {
  const oldSource = "export function Stable() { return 1; }\n";
  const currentSource = "export function Phantom() { return 2; }\n";
  const { root, file } = await fixture(context, currentSource);
  assert.equal((await generateProject(root)).ok, true);
  const outputs = [".llmnav/cache/manifest.json", ".llmnav/cache/index.json", ".llmnav/cache/graph.json", ".llmnav/ids.jsonl", ".llmnav/order.lock"];
  const readOutputs = () => Promise.all(outputs.map(async name => {
    try { return await readFile(path.join(root, name), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }));
  const previous = await readOutputs();
  assert.ok(previous.slice(0, 3).every(value => typeof value === "string"));
  for (const operation of ["discover", "generate-full", "generate-incremental", "check"]) {
    await writeFile(file, oldSource);
    let reads = 0;
    const io = { readFile: async (current, encoding, options) => {
      const text = await readFile(current, { encoding, ...options });
      if (current === file && ++reads === 1) await writeFile(file, currentSource);
      return text;
    } };
    if (operation === "discover") {
      await assert.rejects(discoverProject(root, "Phantom", { precise: true, includeSource: true, io }), /Compiler input changed since source scan: main\.ts/u);
    } else {
      const result = operation === "check" ? await executeAgentOperation(root, "llmnav_check", {}, { io })
        : await generateProject(root, { incremental: operation !== "generate-full", useStatHints: false, io });
      assert.equal(result.ok, false, operation);
      assert.ok((result.diagnostics ?? result.data.diagnostics).some(item => item.code === "LNV014" && /changed since source scan/u.test(item.message)), operation);
    }
    assert.equal(reads, 2, "Reuse the existing scan and freshness reads");
    assert.equal(await readFile(file, "utf8"), currentSource);
    assert.deepEqual(await readOutputs(), previous);
  }
  context.diagnostic(JSON.stringify({ rejectedMixedSnapshots: 4, sourceReadsPerOperation: 2, preservedOutputPaths: outputs.length }));
});

test("consistent snapshots retain byte hashes, legacy decoded hashes and schema-one indexes", async context => {
  const bytes = Buffer.concat([Buffer.from('\ufeffexport function Phantom() { return "한😀"; }\r\n// '), Buffer.from([255]), Buffer.from("\r\n")]);
  const { root, graph, graphFile } = await fixture(context, bytes);
  for (const kind of ["bytes", "decoded-text", "schema-one"]) {
    const input = kind === "schema-one" ? { ...graph, schemaVersion: 1 } : { ...graph, sourceHashes: { "main.ts": sha256(kind === "bytes" ? bytes : bytes.toString("utf8")) } };
    if (kind === "schema-one") delete input.sourceHashes;
    await writeFile(graphFile, JSON.stringify(input));
    const result = await discoverProject(root, "Phantom", { precise: true, includeSource: true, top: 1 });
    assert.equal(result.results[0].symbol, "Phantom", kind);
    assert.match(result.results[0].sourceExcerpt.text, /function Phantom/u);
    assert.equal((await generateProject(root)).ok, true, kind);
  }
});
