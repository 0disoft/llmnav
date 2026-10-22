import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compatibleModuleResolution, loadModuleResolution, resolveGoImportModule } from "../src/module-resolution.js";

function resolutionOf(goModules) {
  return { schemaVersion: 1, resolverVersion: 1, goModules };
}

test("Go metadata reads respect concurrency while keeping sorted results and error order", { timeout: 5000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-module-io-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const records = [];
  for (const name of ["d", "c", "b", "a"]) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "go.mod"), `module example.com/${name}\n`);
    records.push({ relativePath: `${name}/main.go` }, { relativePath: `${name}/other.go` });
  }
  const both = Promise.withResolvers();
  let active = 0, peak = 0, calls = 0;
  const result = await loadModuleResolution(root, records, { ioConcurrency: 2, io: {
    readFile: async (...args) => {
      calls++; active++; peak = Math.max(peak, active);
      if (active === 2) both.resolve();
      await both.promise;
      try { return await readFile(args[0], args[1]); } finally { active--; }
    },
  } });
  assert.equal(peak, 2); assert.equal(calls, 4); assert.equal(active, 0);
  assert.deepEqual(result.goModules.map(module => module.directory), ["a", "b", "c", "d"]);
  const second = Promise.withResolvers(), firstFailure = new Error("a failed");
  await assert.rejects(() => loadModuleResolution(root, records, { ioConcurrency: 2, io: {
    readFile: async file => {
      if (path.dirname(file) === path.join(root, "a")) { await second.promise; throw firstFailure; }
      second.resolve(); throw new Error("b failed earlier");
    },
  } }), error => error === firstFailure);
});

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
