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
