import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadGraphInputs, normalizeGraphInput } from "../src/graph-input.js";
import { DEFAULT_CONFIG } from "../src/spec.js";

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
