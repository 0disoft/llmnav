import assert from "node:assert/strict";
import test from "node:test";
import { rankSourceCandidates, summarizeMeasurements } from "../benchmarks/real-navigation.js";

test("retrieval evidence separates exact declaration lines, deduplicated files and missing answers", () => {
  const input=[{path:"wrong.ts",line:1},{path:"./right.ts",line:4},{path:"right.ts",line:20}];
  assert.deepEqual(rankSourceCandidates(input,"right.ts",20), {fileRank:2,definitionRank:3,fileAt1:false,fileAt5:true,definitionAt1:false,definitionAt5:true});
  assert.deepEqual(rankSourceCandidates(input,"absent.ts",1), {fileRank:null,definitionRank:null,fileAt1:false,fileAt5:false,definitionAt1:false,definitionAt5:false});
});

test("navigation summaries use the middle pair for even sample counts", () => {
  const rows = [100, 2, 10, 4].map(lookupMs => ({ lookupMs, inspectedSourceBytes: 3, toolCalls: 2 }));
  assert.equal(summarizeMeasurements(rows, "test").medianLookupMs, 7);
  assert.equal(summarizeMeasurements(rows.slice(1), "test").medianLookupMs, 4);
  assert.equal(summarizeMeasurements([], "test").medianLookupMs, null);
  assert.deepEqual(rows.map(row => row.lookupMs), [100, 2, 10, 4]);
});
