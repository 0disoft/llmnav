import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { collectSourceFiles } from "../src/files.js";
import { globToRegExp, matchesAnyGlob } from "../src/util.js";

test("globs without a separator match names at any depth", () => {
  assert.equal(matchesAnyGlob("app.min.js", ["*.min.js"]), true);
  assert.equal(matchesAnyGlob("src/assets/app.min.js", ["*.min.js"]), true);
  assert.equal(matchesAnyGlob("src/assets/app.js", ["*.min.js"]), false);
  assert.equal(matchesAnyGlob("src/a.min.js.map", ["*.min.js"]), false);
});

test("globs with a separator stay anchored at the repository root", () => {
  assert.equal(matchesAnyGlob("src/generated/api.js", ["src/generated/*.js"]), true);
  assert.equal(matchesAnyGlob("nested/src/generated/api.js", ["src/generated/*.js"]), false);
  assert.equal(matchesAnyGlob("src/main.ts", ["src/**"]), true);
  assert.equal(matchesAnyGlob("src/deep/main.ts", ["src/**"]), true);
  assert.equal(matchesAnyGlob("src", ["src/**"]), false);
});

test("a double star spans directories only as a whole segment", () => {
  assert.deepEqual(
    [
      "a/b/c.txt",
      "a/c.txt",
      "a/bc.txt",
      "abc.txt",
      "a/b/c.d.txt",
    ].filter((candidate) => matchesAnyGlob(candidate, ["a/**/c.txt"])),
    ["a/b/c.txt", "a/c.txt"],
  );
  assert.equal(matchesAnyGlob("ab.txt", ["a**b.txt"]), true);
  assert.equal(matchesAnyGlob("a/b.txt", ["a**b.txt"]), false);
  assert.equal(matchesAnyGlob("a/deep/b.txt", ["a**b.txt"]), false);
  assert.equal(matchesAnyGlob("aXb.txt", ["a**b.txt"]), true);
  assert.equal(matchesAnyGlob("any/deep/file.txt", ["**"]), true);
  assert.equal(matchesAnyGlob("docs/readme.md", ["?.md"]), false);
  assert.equal(globToRegExp("src/[a].js").test("src/a.js"), false);
});

test("source collection applies the documented defaults to nested files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-file-selection-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"file-selection-fixture"}\n');
  await mkdir(path.join(root, "src", "vendor"), { recursive: true });
  await mkdir(path.join(root, "src", "generated"), { recursive: true });
  await writeFile(path.join(root, "app.min.js"), "export const rooted = 1;\n");
  await writeFile(path.join(root, "src", "vendor", "bundle.min.js"), "export const nested = 1;\n");
  await writeFile(path.join(root, "src", "app.js"), "export const app = 1;\n");
  await writeFile(path.join(root, "src", "generated", "api.js"), "export const api = 1;\n");
  await writeFile(path.join(root, "src", "generated", "keep.js"), "export const keep = 1;\n");

  const { config } = await loadConfig(root);
  const selected = await collectSourceFiles(root, config);
  assert.deepEqual(selected.map((file) => path.relative(root, file).split(path.sep).join("/")), [
    "src/app.js",
    "src/generated/api.js",
    "src/generated/keep.js",
  ]);

  const narrowed = await collectSourceFiles(root, { ...config, excludeFiles: ["src/generated/*.js", "*.min.js"] });
  assert.deepEqual(narrowed.map((file) => path.relative(root, file).split(path.sep).join("/")), ["src/app.js"]);
});
