import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";
import { analyzeTypeScript } from "../src/adapters/typescript.js";
import { sha256 } from "../src/util.js";

async function fixture(context, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-typescript-snapshot-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "source-snapshot" }));
  const file = path.join(root, "main.mts");
  await writeFile(file, source);
  return { root, file };
}

test("TypeScript fingerprints the selected source bytes consumed by the compiler", async context => {
  const source = "\ufeff// 한글 😀\r\nexport function stable(value: string): string { return value; }\r\n";
  const { root, file } = await fixture(context, source);
  const raw = await analyzeTypeScript(root, [file], { metadata: true });
  assert.equal(raw.configHashes["main.mts"], sha256(await readFile(file)));
  assert.equal(raw.declarations.find(row => row.symbol === "stable").metadata.type, "(value: string) => string");
  assert.equal(raw.declarations.find(row => row.symbol === "stable").line, 2);
  const result = await analyzeProject(root, { language: "typescript", metadata: true });
  assert.equal(result.graph.sourceHashes["main.mts"], raw.configHashes["main.mts"]);
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
});

test("TypeScript rejects a transient compiled source even after undo and preserves published output", async context => {
  const source = "export function stable(value: string): string { return value; }\n";
  const transient = "export function phantom(value: number): number { return value; }\n";
  const { root, file } = await fixture(context, source);
  const output = ".llmnav/imports/code.json";
  await writeAnalysis(root, output, await analyzeProject(root, { language: "typescript", metadata: true }));
  const published = await readFile(path.join(root, output), "utf8");
  const compiler = createRequire(import.meta.url).resolve("typescript");
  const wrapper = path.join(root, "compiler.cjs");
  // Deterministically replace A with B only during compilation, then restore A
  // before the parent rechecks the filesystem. No sleeps or editor timing races.
  await writeFile(wrapper, [
    `const fs = require("node:fs"), ts = require(${JSON.stringify(compiler)});`,
    "module.exports = { ...ts, createProgram(...args) {",
    `  fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(transient)});`,
    "  try { return ts.createProgram(...args); }",
    `  finally { fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(source)}); }`,
    "} };",
  ].join("\n"));
  await assert.rejects(async () => {
    const result = await analyzeProject(root, { language: "typescript", typescriptPath: wrapper, metadata: true });
    await writeAnalysis(root, output, result);
  }, /Source changed during analysis: main\.mts/u);
  assert.equal(await readFile(file, "utf8"), source);
  assert.equal(await readFile(path.join(root, output), "utf8"), published);
});
