import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { collectSourceFiles } from "../src/files.js";
import { discoverProject } from "../src/discovery.js";
import { scanProject } from "../src/project.js";
import { globToRegExp, matchesAnyGlob } from "../src/util.js";

test("source roots and explicit paths reject intermediate links before reading outside source", async context => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "llmnav-source-containment-"));
  context.after(async () => {
    assert.equal(path.dirname(parent), path.resolve(os.tmpdir()));
    assert.ok(path.basename(parent).startsWith("llmnav-source-containment-"));
    await rm(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, "repository"), outside = path.join(parent, "outside");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(outside, "nested"), { recursive: true });
  await writeFile(path.join(root, "src/safe.js"), "export function safeFixture() {}\n");
  await writeFile(path.join(outside, "nested/secret.js"), "export function outsideFixtureCanary() {}\n");
  await symlink(outside, path.join(root, "src/link"), process.platform === "win32" ? "junction" : "dir");
  const { config } = await loadConfig(root);
  for (const selected of ["src/link", "src/link/nested", "src/link/nested/secret.js"]) {
    await assert.rejects(collectSourceFiles(root, { ...config, sourceRoots: [selected] }), /symbolic link/u);
    await assert.rejects(collectSourceFiles(root, config, [selected]), /symbolic link/u);
  }
  assert.deepEqual(await collectSourceFiles(root, { ...config, sourceRoots: ["src"] }), [path.join(root, "src/safe.js")]);
  const alias = path.join(parent, "root-alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(collectSourceFiles(alias, { ...config, sourceRoots: ["."] }), /symbolic link/u);
  await assert.rejects(scanProject(root, { paths: ["src/link/nested/secret.js"] }), /symbolic link/u);
  await assert.rejects(discoverProject(root, "outsideFixtureCanary", {
    paths: ["src/link/nested/secret.js"], includeSource: true,
  }), /symbolic link/u);
  await mkdir(path.join(root, ".llmnav"));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "containment", sourceRoots: ["src/link/nested"] }));
  await assert.rejects(scanProject(root), /symbolic link/u);
  await assert.rejects(discoverProject(root, "outsideFixtureCanary", { includeSource: true }), /symbolic link/u);
});

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

test("default selection treats MTS and CTS and their declarations like TS", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-ts-extensions-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const names = ["app.ts", "app.mts", "app.cts", "app.d.ts", "app.d.mts", "app.d.cts"];
  for (const name of names) await writeFile(path.join(root, name), "export const value = 1;\n");
  const { config } = await loadConfig(root);
  assert.deepEqual((await collectSourceFiles(root, config)).map(file => path.basename(file)), names.sort());
});
