import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticsToSarif, SARIF_SCHEMA, SARIF_VERSION } from "../src/sarif.js";

test("serializes deterministic SARIF 2.1.0 diagnostics", () => {
  const diagnostics = [
    { severity: "warning", code: "LNV009", message: "Contract changed.", file: "src\\api.ts", line: 9, column: 2 },
    { severity: "error", code: "LNV001", message: "Role is missing.", file: "src/api.ts", line: 2, column: 1 },
  ];
  const first = diagnosticsToSarif(diagnostics);
  const second = diagnosticsToSarif([...diagnostics].reverse());
  assert.deepEqual(second, first);
  assert.equal(first.$schema, SARIF_SCHEMA);
  assert.equal(first.version, SARIF_VERSION);
  assert.deepEqual(first.runs[0].tool.driver.rules.map((item) => item.id), ["LNV001", "LNV009"]);
  assert.deepEqual(first.runs[0].results.map((item) => item.ruleId), ["LNV001", "LNV009"]);
  assert.equal(first.runs[0].results[1].locations[0].physicalLocation.artifactLocation.uri, "src/api.ts");
  assert.equal(first.runs[0].results[0].level, "error");
});
