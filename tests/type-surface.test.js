import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as api from "../src/index.js";

test("public package version matches both npm manifests", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(api.PACKAGE_VERSION, packageJson.version);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
});

test("every public runtime export has a declaration and every declared value exists", async () => {
  const declarationSource = [
    await readFile(new URL("../src/index.d.ts", import.meta.url), "utf8"),
    await readFile(new URL("../src/spec.d.ts", import.meta.url), "utf8"),
  ].join("\n");
  const declaredValues = new Set(
    [...declarationSource.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gmu)]
      .map((match) => match[1]),
  );
  const runtimeValues = new Set(Object.keys(api));
  assert.deepEqual(
    [...runtimeValues].filter((name) => !declaredValues.has(name)).sort(),
    [],
    "runtime exports missing from index.d.ts",
  );
  assert.deepEqual(
    [...declaredValues].filter((name) => !runtimeValues.has(name)).sort(),
    [],
    "index.d.ts values missing at runtime",
  );
});
