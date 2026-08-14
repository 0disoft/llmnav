import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageRoot = new URL("../", import.meta.url);

test("public releases keep npm provenance enabled across package and workflow metadata", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
  const releaseWorkflow = await readFile(new URL(".github/workflows/release.yml", packageRoot), "utf8");

  assert.equal(packageJson.publishConfig?.provenance, true);
  assert.match(releaseWorkflow, /\bnpm publish\b[^\n]*--provenance(?:\s|$)/u);
  assert.doesNotMatch(releaseWorkflow, /\bnpm publish\b[^\n]*--provenance=false\b/u);
});
