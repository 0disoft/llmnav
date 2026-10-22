import assert from "node:assert/strict";
import test from "node:test";
import { compatibleModuleResolution, resolveGoImportModule } from "../src/module-resolution.js";

function resolutionOf(goModules) {
  return { schemaVersion: 1, resolverVersion: 1, goModules };
}

test("normalizes go module metadata once per immutable snapshot", () => {
  const raw = resolutionOf([
    { directory: "internal/shared", modulePath: "example.com/shared" },
    { directory: "", modulePath: "example.com/root" },
  ]);

  const first = compatibleModuleResolution(raw);
  assert.equal(compatibleModuleResolution(raw), first);
  assert.deepEqual(first.goModules.map((item) => item.directory), ["", "internal/shared"]);
  assert.deepEqual(compatibleModuleResolution(raw).goModules, first.goModules);

  assert.deepEqual(compatibleModuleResolution(null).goModules, []);
  assert.deepEqual(compatibleModuleResolution({ schemaVersion: 2, goModules: [] }).goModules, []);
  assert.deepEqual(compatibleModuleResolution({ schemaVersion: 1, goModules: [{ modulePath: "" }] }).goModules, []);
});

test("resolves the longest matching go module regardless of declaration order", () => {
  const available = new Set(["go:internal/shared/api", "go:internal/shared"]);
  const nested = resolutionOf([
    { directory: "", modulePath: "example.com/root" },
    { directory: "internal/shared/api", modulePath: "example.com/root/internal/shared/api" },
    { directory: "internal/shared", modulePath: "example.com/root/internal/shared" },
  ]);

  assert.equal(
    resolveGoImportModule("cmd/main.go", "example.com/root/internal/shared/api", nested, available),
    "go:internal/shared/api",
  );
  assert.equal(
    resolveGoImportModule("cmd/main.go", "example.com/root/internal/shared", nested, available),
    "go:internal/shared",
  );
  assert.equal(
    resolveGoImportModule("cmd/main.go", "example.com/root/internal/shared/api", nested, new Set(["go:other"])),
    null,
  );
  assert.equal(resolveGoImportModule("cmd/main.go", "example.com/legacy", nested, available), null);
  assert.equal(resolveGoImportModule("src/app.ts", "example.com/root", nested, available), null);
});
