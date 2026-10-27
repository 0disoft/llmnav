import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertCompilerInputFresh, loadGraphInputs, normalizeGraphInput } from "../src/graph-input.js";
import { DEFAULT_CONFIG } from "../src/spec.js";
import { sha256 } from "../src/util.js";

async function compilerFixture(context, count = 32) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-compiler-validation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("export const value = true;\n");
  const sourceHashes = {};
  for (let index = 0; index < count; index++) {
    const name = `input-${index}.ts`;
    await writeFile(path.join(root, name), bytes);
    sourceHashes[name] = sha256(bytes);
  }
  return { root, bytes, graph: { schemaVersion: 2, repositoryId: "fixture", sourceHashes, definitions: [], references: [] } };
}

test("compiler freshness reads overlap within the configured bound", { timeout: 5000 }, async context => {
  const { root, bytes, graph } = await compilerFixture(context);
  const limit = 4;
  const release = Promise.withResolvers(), saturated = Promise.withResolvers();
  let active = 0, peak = 0, reads = 0;
  // Release even on a failed assertion so the test never strands owned reads.
  const guard = setTimeout(() => saturated.resolve(), 1000);
  const work = assertCompilerInputFresh(root, graph, DEFAULT_CONFIG, { ioConcurrency: limit, io: {
    readBytes: async () => {
      reads++; active++; peak = Math.max(peak, active);
      if (active === limit) saturated.resolve();
      try { await release.promise; return bytes; } finally { active--; }
    },
  } });
  try {
    await saturated.promise;
    context.diagnostic(JSON.stringify({ inputs: 32, concurrencyLimit: limit, peakReads: peak }));
    assert.equal(peak, limit);
  } finally {
    clearTimeout(guard);
    release.resolve();
    await work;
  }
  assert.equal(reads, 32);
  assert.equal(active, 0);
  assert.ok(peak <= limit);
});

test("concurrent compiler freshness keeps input-order errors and propagates cancellation", async context => {
  const { root, bytes, graph } = await compilerFixture(context, 2);
  const secondRead = Promise.withResolvers();
  let reads = 0, active = 0;
  await assert.rejects(assertCompilerInputFresh(root, graph, DEFAULT_CONFIG, { ioConcurrency: 2, io: {
    readBytes: async file => {
      reads++; active++;
      try {
        if (path.basename(file) === "input-0.ts") await secondRead.promise;
        else secondRead.resolve();
        return Buffer.from("changed");
      } finally { active--; }
    },
  } }), /Stale compiler analysis for input-0\.ts/u);
  assert.equal(reads, 2);
  assert.equal(active, 0);
  const controller = new AbortController(), reason = new Error("stop compiler validation");
  reads = 0;
  await assert.rejects(assertCompilerInputFresh(root, graph, DEFAULT_CONFIG, { signal: controller.signal, ioConcurrency: 1, io: {
    readBytes: async () => { reads++; controller.abort(reason); return bytes; },
  } }), error => error === reason);
  assert.equal(reads, 1);
});

test("normalizes generated definition and reference indexes deterministically", () => {
  const normalized = normalizeGraphInput({
    schemaVersion: 1,
    repositoryId: "payments",
    generator: "scip-adapter@1",
    definitions: [
      { id: "billing.capture.run", symbol: "runCapture", path: "src/capture.ts", line: 4, kind: "function" },
      { id: "accounts/auth.session.rotate", symbol: "rotate", path: "src/external.ts" },
    ],
    references: [
      { from: "billing.capture.run", to: "accounts/auth.session.rotate", kind: "calls", confidence: 0.9 },
    ],
  }, ".llmnav/imports/payments.json", "abc");

  assert.equal(normalized.definitions[0].id, "accounts/auth.session.rotate");
  assert.equal(normalized.definitions[1].id, "payments/billing.capture.run");
  assert.deepEqual(normalized.references[0], {
    from: "payments/billing.capture.run",
    to: "accounts/auth.session.rotate",
    kind: "calls",
    path: null,
    line: null,
    confidence: 0.9,
  });
});

test("graph loading preserves schema output within one full-sort budget", async context => {
  const { root, bytes, graph } = await compilerFixture(context, 1);
  const config = { ...DEFAULT_CONFIG, graph: { ...DEFAULT_CONFIG.graph, indexFiles: ["graph.json"] } };
  const file = path.join(root, "graph.json");
  const definitions = Array.from({ length: 1000 }, (_, index) => ({
    id: `node.n${999 - index}`, symbol: `function${index}`, path: "input-0.ts", line: index + 1,
  }));
  const references = Array.from({ length: 2000 }, (_, index) => ({
    from: `node.n${index % 1000}`, to: "node.n0", kind: "calls", path: "input-0.ts",
  }));
  for (const schemaVersion of [1, 2, 3]) {
    const input = { ...graph, schemaVersion, definitions, references };
    if (schemaVersion === 1) delete input.sourceHashes;
    if (schemaVersion === 3) input.definitions = [{ ...definitions[0], metadata: {
      language: "typescript", category: "function", owner: null, status: "available",
      type: "number", typeOrigin: "declared", signatures: ["(value: number):\r\nnumber"],
      parameters: [{ name: "value", type: "number", typeOrigin: "declared", optional: false, variadic: false }],
    } }, ...definitions.slice(1)];
    const text = JSON.stringify(input);
    await writeFile(file, text);
    const expected = normalizeGraphInput(input, "graph.json", sha256(text));
    const sort = Array.prototype.sort;
    let sortedRows = 0, sourceReads = 0, result;
    try {
      Array.prototype.sort = function (...args) {
        if (this[0]?.path === "input-0.ts") sortedRows += this.length;
        return Reflect.apply(sort, this, args);
      };
      result = await loadGraphInputs(root, config, { io: {
        readBytes: async () => { sourceReads++; return bytes; },
      } });
    } finally { Array.prototype.sort = sort; }
    assert.deepEqual(result, { indexes: [expected], diagnostics: [] }, `schema ${schemaVersion}`);
    assert.ok(sortedRows <= definitions.length + references.length, `schema ${schemaVersion}: sorted ${sortedRows} rows`);
    assert.equal(sourceReads, schemaVersion >= 2 ? 1 : 0);
    context.diagnostic(JSON.stringify({ schemaVersion, sortedRows, sourceReads }));
  }
});

test("graph loading validates before source I/O and propagates freshness cancellation", async context => {
  const { root, bytes, graph } = await compilerFixture(context, 1);
  const config = { ...DEFAULT_CONFIG, graph: { ...DEFAULT_CONFIG.graph, indexFiles: ["graph.json"] } };
  const file = path.join(root, "graph.json");
  const definition = { id: "same.id", symbol: "value", path: "input-0.ts" };
  await writeFile(file, JSON.stringify({ ...graph, definitions: [definition, definition] }));
  let sourceReads = 0;
  const io = { readBytes: async () => { sourceReads++; return Buffer.from("changed"); } };
  const invalid = await loadGraphInputs(root, config, { io });
  assert.equal(sourceReads, 0);
  assert.equal(invalid.diagnostics[0].code, "LNV014");
  assert.match(invalid.diagnostics[0].message, /duplicate ID/u);
  await writeFile(file, JSON.stringify(graph));
  const stale = await loadGraphInputs(root, config, { io });
  assert.equal(sourceReads, 1);
  assert.deepEqual(stale.indexes, []);
  assert.equal(stale.diagnostics[0].code, "LNV014");
  assert.match(stale.diagnostics[0].message, /Stale compiler analysis/u);
  const controller = new AbortController(), reason = new Error("cancel imported graph");
  await assert.rejects(loadGraphInputs(root, config, { signal: controller.signal, io: {
    readBytes: async () => { controller.abort(reason); return bytes; },
  } }), error => error === reason);
});

test("rejects malformed or escaping graph indexes with LNV014", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-graph-input-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav", "imports"), { recursive: true });
  await writeFile(path.join(root, ".llmnav", "imports", "bad.json"), '{"schemaVersion":1,"repositoryId":"bad","definitions":[{"id":"bad.id","symbol":"x","path":"../escape.ts"}],"references":[]}\n');
  const config = structuredClone(DEFAULT_CONFIG);
  config.graph.indexFiles = [".llmnav/imports/bad.json", ".llmnav/imports/missing.json"];
  const result = await loadGraphInputs(root, config);
  assert.equal(result.indexes.length, 0);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every((item) => item.code === "LNV014" && item.severity === "error"));
});

test("rejects unknown fields, duplicate definitions, and invalid confidence", () => {
  assert.throws(() => normalizeGraphInput({ schemaVersion: 1, repositoryId: "repo", definitions: [], references: [], extra: true }), /unknown property/u);
  assert.throws(() => normalizeGraphInput({
    schemaVersion: 1,
    repositoryId: "repo",
    definitions: [
      { id: "same.id", symbol: "a", path: "a.ts" },
      { id: "same.id", symbol: "b", path: "b.ts" },
    ],
    references: [],
  }), /duplicate ID/u);
  assert.throws(() => normalizeGraphInput({
    schemaVersion: 1,
    repositoryId: "repo",
    definitions: [],
    references: [{ from: "from.id", to: "to.id", kind: "calls", confidence: 2 }],
  }), /number from 0 to 1/u);
});
