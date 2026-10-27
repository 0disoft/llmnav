import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";
import { analyzeGo } from "../src/adapters/go.js";
import { analyzeTypeScript } from "../src/adapters/typescript.js";
import { discoverProject } from "../src/discovery.js";
import { generateProject } from "../src/generator.js";
import { showProjectCard, buildContext } from "../src/search.js";
import { loadConfig } from "../src/config.js";
import { loadGraphInputs, normalizeGraphInput } from "../src/graph-input.js";

async function fixture(context, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-compiler-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "compiler-fixture", graph: { indexFiles: [".llmnav/imports/code.json"] } }));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}
const card = "/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate a session token.\nsearch=rotate session|session token\nstability=contract\n*/\n";

test("TypeScript binds overloaded implementations to reviewed cards and call edges", async context => {
  const lib = "function helper(token: string | number) { return token; }\n" +
    "export function rotate(token: string): string;\nexport function rotate(token: number): number;\n" +
    `${card}export function rotate(token: string | number) { return helper(token); }\n` +
    "export class Session<T> {\n  rotate(token: string): string;\n  rotate(token: T): T;\n" +
    "  rotate(token: string | T) { return token; }\n}\n";
  const root = await fixture(context, {
    "lib.mts": lib,
    "ambient.d.mts": "export declare function ambient(token: string): string;\nexport declare function ambient(token: number): number;\n",
    "main.mts": "import { rotate as renamed, Session } from './lib.mjs';\nimport { ambient } from './ambient.mjs';\n" +
      "export function invoke() { return renamed('ok'); }\nexport function invokeNumber() { return renamed(1); }\n" +
      "export function methodString() { return new Session<number>().rotate('ok'); }\nexport function methodNumber() { return new Session<number>().rotate(1); }\n" +
      "export function ambientCall() { return ambient(1); }\n",
  });
  const result = await analyzeProject(root, { language: "typescript" });
  const definitions = result.graph.definitions;
  const method = definitions.find(item => item.symbol === "Session.rotate");
  const incoming = ["invoke", "invokeNumber", "methodString", "methodNumber"].map(name => {
    const caller = definitions.find(item => item.symbol === name);
    const target = name.startsWith("method") ? method.id : "auth.session.rotate";
    return result.graph.references.some(edge => edge.from === caller.id && edge.to === target && edge.kind === "calls");
  });
  context.diagnostic(JSON.stringify({ cardBindings: result.counts.cardBindings, incomingFunctionCalls: incoming.slice(0, 2).filter(Boolean).length, incomingMethodCalls: incoming.slice(2).filter(Boolean).length }));
  assert.equal(result.counts.cardBindings, 1);
  assert.deepEqual(incoming, [true, true, true, true]);
  for (const [symbol, id, implementation] of [["rotate", "auth.session.rotate", "export function rotate(token: string | number)"], ["Session.rotate", method.id, "  rotate(token: string | T)"]]) {
    const matches = definitions.filter(item => item.symbol === symbol);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, id);
    assert.equal(matches[0].line, lib.slice(0, lib.indexOf(implementation)).split("\n").length);
  }
  const helper = definitions.find(item => item.symbol === "helper");
  assert.ok(result.graph.references.some(edge => edge.from === "auth.session.rotate" && edge.to === helper.id && edge.kind === "calls"));
  const ambient = definitions.filter(item => item.symbol === "ambient");
  assert.equal(ambient.length, 1);
  assert.equal(ambient[0].line, 1);
  const ambientCaller = definitions.find(item => item.symbol === "ambientCall");
  assert.ok(result.graph.references.some(edge => edge.from === ambientCaller.id && edge.to === ambient[0].id && edge.kind === "calls"));
  assert.deepEqual((await analyzeProject(root, { language: "typescript" })).graph, result.graph);
  normalizeGraphInput(result.graph);
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
  assert.equal((await generateProject(root)).ok, true);
  const precise = (await discoverProject(root, "rotate", { precise: true, top: 10 })).results.find(item => item.id === "compiler-fixture/auth.session.rotate");
  assert.equal(precise.source, "compiler");
  assert.equal(precise.line, definitions.find(item => item.id === "auth.session.rotate").line);
  assert.equal((await showProjectCard(root, "auth.session.rotate")).card.id, "auth.session.rotate");
  const signatureCard = lib.replace(card, "").replace("export function rotate(token: string): string;", `${card}export function rotate(token: string): string;`);
  await writeFile(path.join(root, "lib.mts"), signatureCard);
  const legacy = await analyzeProject(root, { language: "typescript" });
  assert.equal(legacy.counts.cardBindings, 1);
  assert.equal(legacy.graph.definitions.find(item => item.id === "auth.session.rotate").line, precise.line);
  for (const name of ["invoke", "invokeNumber"]) {
    const caller = legacy.graph.definitions.find(item => item.symbol === name);
    assert.ok(legacy.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  }
});

test("TypeScript invalidates compiler graphs when an extended configuration changes", async context => {
  const root = await fixture(context, {
    "first.mts": `${card}export function rotate(token: string) { return token; }\n`,
    "second.mts": "export function rotate(token: string) { return token + '!'; }\n",
    "main.mts": "import { rotate } from 'implementation';\nexport function invoke() { return rotate('ok'); }\n",
    "tsconfig.json": JSON.stringify({ extends: "./config/base.json", files: ["first.mts", "second.mts", "main.mts"] }),
    "config/base.json": JSON.stringify({ extends: "./shared.json", compilerOptions: { paths: { implementation: ["../first.mts"] } } }),
    "config/shared.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", types: [] } }),
  });
  const options = { language: "typescript", project: "tsconfig.json" };
  const result = await analyzeProject(root, options);
  const caller = result.graph.definitions.find(item => item.symbol === "invoke");
  assert.ok(result.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
  const saved = await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8");
  const { config } = await loadConfig(root);
  assert.equal((await loadGraphInputs(root, config)).diagnostics.length, 0);
  await writeFile(path.join(root, "config/base.json"), JSON.stringify({ extends: "./shared.json", compilerOptions: { paths: { implementation: ["../second.mts"] } } }));
  const loaded = await loadGraphInputs(root, config);
  context.diagnostic(JSON.stringify({ acceptedStaleIndexes: loaded.indexes.length, diagnostics: loaded.diagnostics.length }));
  assert.equal(loaded.indexes.length, 0);
  assert.match(loaded.diagnostics[0].message, /Stale compiler analysis for config\/base\.json/u);
  await assert.rejects(writeAnalysis(root, ".llmnav/imports/code.json", result), /Stale compiler analysis/u);
  assert.equal(await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8"), saved);
  const refreshed = await analyzeProject(root, options);
  const target = refreshed.graph.definitions.find(item => item.symbol === "rotate" && item.path === "second.mts");
  assert.ok(refreshed.graph.references.some(edge => edge.from === caller.id && edge.to === target.id && edge.kind === "calls"));
  assert.equal(refreshed.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"), false);
  assert.ok(refreshed.graph.sourceHashes["config/shared.json"]);
  assert.equal(Object.keys(result.graph.sourceHashes).length, 6);
  assert.deepEqual((await analyzeProject(root, options)).graph, refreshed.graph);
  await writeAnalysis(root, ".llmnav/imports/code.json", refreshed);
  await writeFile(path.join(root, "config/shared.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /Stale compiler analysis for config\/shared\.json/u);
  await rm(path.join(root, "config/shared.json"));
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /Stale compiler analysis for config\/shared\.json/u);
});

test("TypeScript invalidates compiler graphs when package import mappings change", async context => {
  const manifest = target => JSON.stringify({ name: "compiler-fixture", type: "module", imports: { "#implementation": target } });
  const root = await fixture(context, {
    "package.json": manifest("./first.mjs"),
    "first.mts": `${card}export function rotate(token: string) { return token; }\n`,
    "second.mts": "export function rotate(token: string) { return token + '!'; }\n",
    "main.mts": "import { rotate } from '#implementation';\nexport function invoke() { return rotate('ok'); }\n",
  });
  const options = { language: "typescript" };
  const result = await analyzeProject(root, options);
  const caller = result.graph.definitions.find(item => item.symbol === "invoke");
  assert.ok(result.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
  const saved = await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8");
  const { config } = await loadConfig(root);
  assert.equal((await loadGraphInputs(root, config)).diagnostics.length, 0);

  await writeFile(path.join(root, "package.json"), manifest("./second.mjs"));
  const loaded = await loadGraphInputs(root, config);
  context.diagnostic(JSON.stringify({ acceptedStaleIndexes: loaded.indexes.length, diagnostics: loaded.diagnostics.length }));
  assert.equal(loaded.indexes.length, 0);
  assert.match(loaded.diagnostics[0].message, /Stale compiler analysis for package\.json/u);
  await assert.rejects(writeAnalysis(root, ".llmnav/imports/code.json", result), /Stale compiler analysis/u);
  assert.equal(await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8"), saved);

  const refreshed = await analyzeProject(root, options);
  const target = refreshed.graph.definitions.find(item => item.symbol === "rotate" && item.path === "second.mts");
  assert.ok(refreshed.graph.references.some(edge => edge.from === caller.id && edge.to === target.id && edge.kind === "calls"));
  assert.equal(refreshed.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"), false);
  assert.ok(refreshed.graph.sourceHashes["package.json"]);
  await writeAnalysis(root, ".llmnav/imports/code.json", refreshed);
  await rm(path.join(root, "package.json"));
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /Stale compiler analysis for package\.json/u);
  await writeFile(path.join(root, "package.json"), manifest("./second.mjs"));

  let changedDuringAnalysis = false;
  const io = { readBytes: async file => {
    if (file === path.join(root, "package.json") && !changedDuringAnalysis) {
      changedDuringAnalysis = true;
      await writeFile(file, manifest("./first.mjs"));
    }
    return readFile(file);
  } };
  await assert.rejects(analyzeProject(root, { ...options, io }), /Source changed during analysis: package\.json/u);
  assert.equal(changedDuringAnalysis, true);
});

test("TypeScript tracks package-based config chains with UTF-8 and UTF-16 BOMs", async context => {
  const shared = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(JSON.stringify({ compilerOptions: { target: "ES2022", types: [] } }), "utf16le").swap16()]);
  const encoded = condition => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ extends: "@fixture/config", files: ["main.mts"], compilerOptions: { customConditions: [condition] } }), "utf16le")]);
  const original = encoded("\u2e80"), changed = encoded("\u2e81");
  assert.equal(original.toString("utf8"), changed.toString("utf8"), "lossy decoding must not hide changed UTF-16 bytes");
  const root = await fixture(context, {
    "main.mts": "export const value = true;\n",
    "tsconfig.json": original,
    "node_modules/@fixture/config/package.json": JSON.stringify({ name: "@fixture/config", tsconfig: "base.json" }),
    "node_modules/@fixture/config/base.json": `\ufeff${JSON.stringify({ extends: "./shared.json", compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } })}`,
    "node_modules/@fixture/config/shared.json": shared,
  });
  const result = await analyzeProject(root, { language: "typescript", project: "tsconfig.json" });
  for (const file of ["tsconfig.json", "node_modules/@fixture/config/package.json", "node_modules/@fixture/config/base.json", "node_modules/@fixture/config/shared.json"]) {
    assert.ok(result.graph.sourceHashes[file], file);
  }
  let byteReads = 0;
  const io = { readBytes: (file, options) => { byteReads++; return readFile(file, options); } };
  await writeAnalysis(root, ".llmnav/imports/code.json", result, { io });
  const { config } = await loadConfig(root);
  assert.equal((await loadGraphInputs(root, config, { io })).diagnostics.length, 0);
  assert.ok(byteReads > 0);
  await writeFile(path.join(root, "tsconfig.json"), changed);
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /Stale compiler analysis for tsconfig\.json/u);
  await writeFile(path.join(root, "tsconfig.json"), original);
  await writeFile(path.join(root, "node_modules/@fixture/config/package.json"), JSON.stringify({ name: "@fixture/config", tsconfig: "shared.json" }));
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /Stale compiler analysis/u);
});

test("TypeScript ignores ancestor package probes without accepting external configurations", async context => {
  const outer = await fixture(context, {
    "project/.llmnav/config.json": JSON.stringify({ repositoryId: "compiler-fixture" }),
    "project/main.mts": "export const value = true;\n",
    "project/tsconfig.json": JSON.stringify({ extends: "@fixture/config", files: ["main.mts"] }),
    "project/node_modules/@fixture/config/package.json": JSON.stringify({ name: "@fixture/config", tsconfig: "base.json" }),
    "project/node_modules/@fixture/config/base.json": JSON.stringify({ compilerOptions: { types: [], module: "NodeNext", moduleResolution: "NodeNext" } }),
  });
  const root = path.join(outer, "project");
  const options = { language: "typescript", project: "tsconfig.json" };
  const baseline = await analyzeProject(root, options);
  for (const manifest of ['{"type":"module"}', 'external-private-marker={invalid-json}']) {
    await writeFile(path.join(outer, "package.json"), manifest);
    const actual = await analyzeProject(root, options);
    assert.deepEqual(actual.graph, baseline.graph);
    assert.deepEqual(actual.diagnostics, baseline.diagnostics);
  }
  await writeFile(path.join(outer, "base.json"), JSON.stringify({ compilerOptions: { types: [] } }));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "../base.json", files: ["main.mts"] }));
  await assert.rejects(analyzeProject(root, options), /configuration must stay inside/u);
});

test("TypeScript resolves package configurations through a repository path alias", async context => {
  const root = await fixture(context, {
    "main.mts": "export const value = true;\n",
    "tsconfig.json": JSON.stringify({ extends: "@fixture/config", files: ["main.mts"] }),
    "node_modules/@fixture/config/package.json": JSON.stringify({ name: "@fixture/config", tsconfig: "base.json" }),
    "node_modules/@fixture/config/base.json": JSON.stringify({ compilerOptions: { types: [], module: "NodeNext", moduleResolution: "NodeNext" } }),
  });
  const alias = `${root}-alias`;
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  context.after(() => rm(alias, { recursive: true, force: true }));
  const options = { project: "tsconfig.json" };
  const expected = await analyzeTypeScript(root, [path.join(root, "main.mts")], options);
  const actual = await analyzeTypeScript(alias, [path.join(alias, "main.mts")], options);
  assert.ok(expected.declarations.some(item => item.symbol === "value"));
  assert.deepEqual(actual, expected);
});

test("TypeScript rejects configuration chains that escape the repository", async context => {
  const outside = await fixture(context, { "base.json": JSON.stringify({ compilerOptions: { types: [] } }) });
  const root = await fixture(context, {
    "main.mts": "export const value = true;\n",
    "tsconfig.json": JSON.stringify({ extends: path.join(outside, "base.json"), files: ["main.mts"] }),
  });
  await assert.rejects(analyzeProject(root, { language: "typescript", project: "tsconfig.json" }), /configuration must stay inside/u);
  await symlink(outside, path.join(root, "config-link"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./config-link/base.json", files: ["main.mts"] }));
  await assert.rejects(analyzeProject(root, { language: "typescript", project: "tsconfig.json" }), /configuration must stay inside/u);
});

test("TypeScript rejects configuration changes across compiler snapshot boundaries", async context => {
  for (const changed of ["tsconfig.json", "base.json"]) {
    const root = await fixture(context, {
      "main.mts": "export const value = true;\n",
      "tsconfig.json": JSON.stringify({ extends: "./base.json", files: ["main.mts"] }),
      "base.json": JSON.stringify({ compilerOptions: { types: [] } }),
    });
    let changedOnce = false;
    const io = { readFile: async (file, encoding, options) => {
      if (file === path.join(root, changed) && !changedOnce) {
        changedOnce = true;
        const replacement = changed === "tsconfig.json"
          ? { extends: "./base.json", files: ["main.mts"], compilerOptions: { strict: true } }
          : { compilerOptions: { types: [], strict: true } };
        // Root config: change after its initial snapshot. Base config: change after compiler use.
        const original = await readFile(file, { encoding, ...options });
        await writeFile(file, JSON.stringify(replacement));
        return changed === "tsconfig.json" ? original : readFile(file, { encoding, ...options });
      }
      return readFile(file, { encoding, ...options });
    } };
    await assert.rejects(analyzeProject(root, { language: "typescript", project: "tsconfig.json", io }), /Source changed during analysis/u);
    assert.equal(changedOnce, true);
  }
});

test("TypeScript preserves definitions and card bindings when Windows tsconfig casing differs", { skip: process.platform !== "win32" }, async context => {
  const options = { compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", types: [] }, files: ["src/lib.mts", "src/main.mts"] };
  const root = await fixture(context, {
    "src/lib.mts": `${card}export function rotate(token: string) { return token; }\n`,
    "src/main.mts": "import { rotate } from './lib.mjs';\nexport function invoke() { return rotate('ok'); }\n",
    "tsconfig.json": JSON.stringify(options),
  });
  const canonical = await analyzeProject(root, { language: "typescript", project: "tsconfig.json" });
  options.files = ["SRC/LIB.mts", "Src/MAIN.mts"];
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify(options));
  const varied = await analyzeProject(root, { language: "typescript", project: "tsconfig.json" });
  assert.ok(canonical.graph.definitions.length > 0);
  assert.equal(canonical.counts.cardBindings, 1);
  assert.deepEqual(varied.graph.definitions, canonical.graph.definitions);
  assert.deepEqual(varied.graph.references, canonical.graph.references);
  assert.equal(varied.counts.cardBindings, 1);
  assert.deepEqual(varied.diagnostics, canonical.diagnostics);
  const caller = varied.graph.definitions.find(item => item.symbol === "invoke");
  assert.ok(varied.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  context.diagnostic(JSON.stringify({ sourceFiles: 2, definitions: varied.counts.definitions, references: varied.counts.references, cardBindings: varied.counts.cardBindings }));
});

test("TypeScript resolves renamed imports and shadowed symbols with fresh compiler provenance", async context => {
  const root = await fixture(context, {
    "wrappers.mts": "import { rotate } from './lib.mjs';\nexport function wrapped() { return (rotate)('ok'); }\nexport function referenceOnly() { return rotate; }\n",
    "lib.mts": `${card}export function rotate(token: string) { return token; }\nexport class One { run() { return rotate('one'); } }\nexport class Two { run() { return 'two'; } }\n`,
    "main.mts": "import { rotate as renamed, One, Two } from './lib.mjs';\nexport function invoke() { const result = renamed('ok'); return result; }\nexport function shadow() { const renamed = (x: string) => x; return renamed('local'); }\nexport function first() { return new One().run(); }\nexport function second() { return new Two().run(); }\nexport function receiver() { const instance = new One(); return instance.run(); }\n",
  });
  const result = await analyzeProject(root, { language: "typescript" });
  const defs = new Map(result.graph.definitions.map(item => [item.id, item]));
  assert.ok(defs.has("auth.session.rotate"));
  const caller = result.graph.definitions.find(item => item.symbol === "invoke");
  const shadow = result.graph.definitions.find(item => item.symbol === "shadow");
  assert.ok(result.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  assert.equal(result.graph.references.some(edge => edge.from === shadow.id && edge.to === "auth.session.rotate"), false);
  const methods = result.graph.definitions.filter(item => item.symbol.endsWith(".run")).sort((a, b) => a.line - b.line);
  assert.equal(methods.length, 2);
  assert.notEqual(methods[0].id, methods[1].id);
  const receiver = result.graph.definitions.find(item => item.symbol === "receiver");
  const instance = result.graph.definitions.find(item => item.symbol === "instance");
  assert.equal(result.graph.references.some(edge => edge.from === receiver.id && edge.to === instance.id && edge.kind === "calls"), false);
  assert.ok(result.graph.references.some(edge => edge.from === receiver.id && edge.to === instance.id && edge.kind === "references"));
  const wrapped = result.graph.definitions.find(item => item.symbol === "wrapped");
  const referenceOnly = result.graph.definitions.find(item => item.symbol === "referenceOnly");
  assert.ok(result.graph.references.some(edge => edge.from === wrapped.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  assert.ok(result.graph.references.some(edge => edge.from === referenceOnly.id && edge.to === "auth.session.rotate" && edge.kind === "references"));
  assert.equal(result.graph.references.some(edge => edge.from === referenceOnly.id && edge.kind === "calls"), false);
  for (const [name, methodIndex] of [["first", 0], ["second", 1]]) {
    const caller = result.graph.definitions.find(item => item.symbol === name);
    assert.ok(result.graph.references.some(edge => edge.from === caller.id && edge.to === methods[methodIndex].id && edge.kind === "calls"), JSON.stringify({ name, methods, references: result.graph.references, caller }));
  }
  assert.deepEqual((await analyzeProject(root, { language: "typescript" })).graph, result.graph);
  normalizeGraphInput(result.graph);
  await writeAnalysis(root, ".llmnav/imports/code.json", result);
  const { config } = await loadConfig(root);
  assert.equal((await loadGraphInputs(root, config)).diagnostics.length, 0);
  assert.equal((await generateProject(root)).ok, true);
  const precise = await discoverProject(root, "invoke", { precise: true });
  assert.equal(precise.results[0].source, "compiler");
  assert.equal(precise.results[0].id, `compiler-fixture/${caller.id}`);
  assert.equal((await showProjectCard(root, precise.results[0].id)).node.definitions[0].symbol, "invoke");
  assert.ok((await buildContext(root, precise.results[0].id)).included.includes("auth.session.rotate"));
  await writeFile(path.join(root, "added.cts"), "export const added = true;\n");
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /source set changed/u);
  await rm(path.join(root, "added.cts"));
  await writeFile(path.join(root, "lib.mts"), "export const changed = true;\n");
  assert.match((await loadGraphInputs(root, config)).diagnostics[0].message, /Stale compiler analysis/u);
  const saved = await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8");
  await assert.rejects(analyzeProject(root, { language: "typescript" }));
  assert.equal(await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8"), saved);
  await assert.rejects(writeAnalysis(root, "../outside.json", result), /escapes/u);
});

test("Go type-checks local packages and separates methods and function-value shadowing", { skip: spawnSync("go", ["version"], { windowsHide: true }).status !== 0, timeout: 120000 }, async context => {
  const root = await fixture(context, {
    "go.mod": "module test.local/fixture\n\ngo 1.22\n",
    "lib/lib.go": `package lib\n${card}func Rotate(token string) string { return token }\ntype One struct{}\nfunc (One) Run() string { return Rotate("one") }\ntype Two struct{}\nfunc (Two) Run() string { return "two" }\n`,
    "main.go": '//line /virtual/ghost.go:999\npackage fixture\nimport "test.local/fixture/lib"\nfunc Invoke() string { return lib.Rotate("ok") }\nfunc Shadow() string { Rotate := func(x string) string { return x }; return Rotate("local") }\nfunc First() string { return lib.One{}.Run() }\nfunc Second() string { return lib.Two{}.Run() }\nfunc LocalVar() string { var result = lib.Rotate("local"); return result }\nfunc Identity[T any](value T) T { return value }\nfunc Generic() string { return Identity[string]("ok") }\n',
  });
  const result = await analyzeProject(root, { language: "go" });
  const caller = result.graph.definitions.find(item => item.symbol === "Invoke");
  assert.equal(caller.path, "main.go");
  assert.equal(caller.line, 4);
  const shadow = result.graph.definitions.find(item => item.symbol === "Shadow");
  assert.ok(result.graph.references.some(edge => edge.from === caller.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  assert.equal(result.graph.references.some(edge => edge.from === shadow.id && edge.to === "auth.session.rotate"), false);
  const local = result.graph.definitions.find(item => item.symbol === "LocalVar");
  assert.ok(result.graph.references.some(edge => edge.from === local.id && edge.to === "auth.session.rotate" && edge.kind === "calls"));
  const generic = result.graph.definitions.find(item => item.symbol === "Generic");
  const identity = result.graph.definitions.find(item => item.symbol === "Identity");
  assert.ok(result.graph.references.some(edge => edge.from === generic.id && edge.to === identity.id && edge.kind === "calls"));
  const methods = result.graph.definitions.filter(item => item.symbol.endsWith(".Run"));
  assert.equal(methods.length, 2);
  for (const name of ["First", "Second"]) {
    const from = result.graph.definitions.find(item => item.symbol === name).id;
    assert.equal(result.graph.references.filter(edge => edge.from === from && methods.some(method => edge.to === method.id) && edge.kind === "calls").length, 1);
  }
  normalizeGraphInput(result.graph);
  assert.equal(result.diagnostics.length, 0);
  const alias = `${root}-alias`;
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  context.after(() => rm(alias, { recursive: true, force: true }));
  // Exercise the compiler boundary directly: project scanning intentionally
  // rejects symlinked source roots, independently of compiler path identity.
  const aliased = await analyzeGo(alias, [path.join(alias, "main.go"), path.join(alias, "lib/lib.go")]);
  const aliasedCaller = aliased.declarations.find(item => item.symbol === "Invoke");
  const aliasedTarget = aliased.declarations.find(item => item.symbol === "Rotate" && item.path === "lib/lib.go");
  assert.equal(aliasedCaller.path, "main.go");
  assert.equal(aliasedCaller.line, 4);
  assert.ok(aliased.references.some(edge => edge.from === aliasedCaller.key && edge.to === aliasedTarget.key && edge.kind === "calls"));
  const outside = `${root}-outside.go`;
  await writeFile(outside, "package fixture\n");
  context.after(() => rm(outside, { force: true }));
  await assert.rejects(analyzeGo(root, [outside]), /source symlink escapes repository/u);
});
