import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { detectBoundaries } from "../src/boundaries.js";
import { createDeclarationScanContext, extractImports, findAttachedDeclaration } from "../src/declaration.js";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { parseLlmnavBlocks } from "../src/parser.js";

test("import extraction bounds scans across semicolon-free export declarations", context => {
  const count = 50000;
  const declarations = Array.from({ length: count }, (_, index) => `export const value${index} = ${index}\n`).join("");
  for (const [label, source, expected] of [
    ["no-quotes", declarations, []],
    ["shared-boundary", `${declarations}const label = "value"\nimport "./actual.js"\n`, ["./actual.js"]],
    ["comment-heads", `/*\n${"export value\nimport value\n".repeat(count)}*/\nimport "./actual.js"\n`, ["./actual.js"]],
  ]) {
    const started = performance.now();
    const imports = runInNewContext('extractImports(source, "constants.ts")',
      { extractImports, source }, { timeout: 3000 });
    assert.deepEqual(imports, expected, label);
    context.diagnostic(JSON.stringify({ label, declarations: count, sourceBytes: Buffer.byteLength(source),
      elapsedMs: Number((performance.now() - started).toFixed(3)) }));
  }
});

test("static module scans preserve multiline bindings, local export boundaries and real imports after comments", () => {
  const source = [
    "/*", "export ignored", "import ignored", "*/",
    'import "./side.js"',
    "import Default, {", "  from as source,", "  export as exported,",
    '} from "./named.js"',
    "export type {", "  A, B,", '} from "./types.js"',
    'export * as ns from "./star.js"',
    "export { A };",
    'const label = "./ignored.js";',
    'import("./dynamic.js"); require("./common.cjs");',
    'import "./named.js";',
  ].join("\n");
  assert.deepEqual(extractImports(source, "fixture.ts"),
    ["./common.cjs", "./dynamic.js", "./named.js", "./side.js", "./star.js", "./types.js"]);
  assert.deepEqual(extractImports('import ""; export * from ""; require("");', "empty.js"), []);
  assert.deepEqual(extractImports('import from "./invalid.js"; export from "./invalid.js";', "invalid.js"), []);
});

test("enriches TypeScript and Go declarations with stable visibility and body hashes", () => {
  const typescript = `${card("api.user.load")}export async function loadUser(id: string): Promise<string> {\n  return id;\n}\n`;
  const [typescriptBlock] = parseLlmnavBlocks(typescript, "src/api/user.ts");
  const typescriptDeclaration = findAttachedDeclaration(typescript, typescriptBlock, "src/api/user.ts");
  assert.equal(typescriptDeclaration.language, "typescript");
  assert.equal(typescriptDeclaration.exported, true);
  assert.equal(typescriptDeclaration.visibility, "public");
  assert.equal(typescriptDeclaration.receiver, null);
  assert.equal(typescriptDeclaration.endOffset, typescript.lastIndexOf("}") + 1);
  assert.match(typescriptDeclaration.bodyHash, /^[a-f0-9]{64}$/u);

  const go = `${card("billing.credit.reserve")}func (ledger *Ledger) ReserveCredits(amount int) error {\n\treturn nil\n}\n`;
  const [goBlock] = parseLlmnavBlocks(go, "billing/reserve.go");
  const goDeclaration = findAttachedDeclaration(go, goBlock, "billing/reserve.go");
  assert.equal(goDeclaration.language, "go");
  assert.equal(goDeclaration.exported, true);
  assert.equal(goDeclaration.visibility, "public");
  assert.equal(goDeclaration.receiver, "Ledger");
});

test("isolates symbol body hashes and detects local structural boundaries", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-declaration-hash-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"declaration-hash-fixture"}\n');
  await mkdir(path.join(root, "src", "routes"), { recursive: true });
  const sourcePath = path.join(root, "src", "routes", "credits.ts");
  await writeFile(sourcePath, `${card("billing.credit.reserve")}export function reserve(): number { return 1; }\n${card("billing.credit.capture")}export function capture(): number { return 2; }\n`);

  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
  const first = JSON.parse(await readFile(path.join(root, ".llmnav", "cache", "index.json"), "utf8"));
  const firstReserve = first.cards.find((item) => item.id === "billing.credit.reserve");
  const firstCapture = first.cards.find((item) => item.id === "billing.credit.capture");
  assert.deepEqual(firstReserve.boundaries, [{ kind: "route", confidence: "high", evidence: ["path"] }]);

  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("return 2", "return 3"));
  const second = await generateProject(root);
  const secondReserve = second.index.cards.find((item) => item.id === "billing.credit.reserve");
  const secondCapture = second.index.cards.find((item) => item.id === "billing.credit.capture");
  assert.equal(secondReserve.hashes.body, firstReserve.hashes.body);
  assert.notEqual(secondCapture.hashes.body, firstCapture.hashes.body);

  assert.deepEqual(
    detectBoundaries({
      relativePath: "migrations/001_credit.sql",
      card: { effect: ["event.emit(billing.changed)"], risk: ["migration"] },
    }).map((item) => item.kind),
    ["event", "migration"],
  );
});

test("JavaScript regex literals do not truncate declaration body hashes", () => {
  const first = `${card("parser.regex.body")}export function parseValue(value) {\n  const closing = /}/u;\n  return value + 1;\n}\n`;
  const second = first.replace("value + 1", "value + 2");
  const [firstBlock] = parseLlmnavBlocks(first, "parser.js");
  const [secondBlock] = parseLlmnavBlocks(second, "parser.js");
  const firstDeclaration = findAttachedDeclaration(first, firstBlock, "parser.js");
  const secondDeclaration = findAttachedDeclaration(second, secondBlock, "parser.js");
  assert.equal(firstDeclaration.endOffset, first.lastIndexOf("}") + 1);
  assert.notEqual(firstDeclaration.bodyHash, secondDeclaration.bodyHash);
});

test("Python declaration hashes include the complete indented body", () => {
  const first = `${card("python.export.prepare").replaceAll("/*", "#").replaceAll("*/", "# /llmnav").replaceAll(/^([^#\n].*)$/gmu, "# $1")}def prepare_export():\n    archive = build_archive()\n    return archive\n`;
  const second = first.replace("return archive", "return encrypt(archive)");
  const [firstBlock] = parseLlmnavBlocks(first, "export.py");
  const [secondBlock] = parseLlmnavBlocks(second, "export.py");
  const firstDeclaration = findAttachedDeclaration(first, firstBlock, "export.py");
  const secondDeclaration = findAttachedDeclaration(second, secondBlock, "export.py");
  assert.equal(firstDeclaration.endOffset, first.length);
  assert.notEqual(firstDeclaration.bodyHash, secondDeclaration.bodyHash);
});

test("Python signatures end at the header colon instead of a brace inside a literal", () => {
  const source = `${card("python.emit")}def emit(payload: dict[str, int]) -> None:\n    label = f"payload:{payload}"\n    return None\n`;
  const [block] = parseLlmnavBlocks(source, "emit.py");
  const declaration = findAttachedDeclaration(source, block, "emit.py");
  assert.equal(declaration.signature, "def emit(payload: dict[str, int]) -> None");
  assert.equal(declaration.endOffset, source.length);
});

test("JavaScript import extraction ignores unrelated string literals and comments", () => {
  const source = `import value from "./value.js";\nimport {\n  multiline,\n} from "./multiline.js";\nexport { other } from "./other.js";\nconst lazy = import("./lazy.js");\nconst required = require("./required.cjs");\nconst label = "LLMNav";\n// require("./comment.js")\nconst url = "https://example.test";\n`;
  assert.deepEqual(extractImports(source, "source.js"), [
    "./lazy.js",
    "./multiline.js",
    "./other.js",
    "./required.cjs",
    "./value.js",
  ]);
});

test("import cursors keep pattern-local lexical state, deduplication and sorted output", () => {
  const source = [
    '/* require("./blocked.cjs");',
    'import "./blocked.js";',
    'export { x } from "./blocked-export.js"; */',
    'const escaped = "a\\\" require(\'./blocked-string.js\')";',
    'const template = `',
    'import "./blocked-template.js";',
    '`;',
    'import "./z.js";',
    'export { x } from "./a.js";',
    'require("./b.js"); import("./a.js");',
    '// require("./blocked-line.js")',
  ].join("\r\n");
  assert.deepEqual(extractImports(source, "fixture.ts"), ["./a.js", "./b.js", "./z.js"]);
  assert.deepEqual(extractImports('/* require("./blocked.js")', "broken.js"), []);
  assert.deepEqual(extractImports('require("./fresh.js")', "fresh.js"), ["./fresh.js"]);
});

test("large interleaved import forms retain every real dependency and exclude comment matches", () => {
  const expected = [];
  const lines = [];
  for (let index = 0; index < 1000; index++) {
    const name = `./dependency${index}.js`;
    expected.push(name);
    lines.push(`import '${name}';`, `export { x } from '${name}';`, `require('${name}');`, `// import('./blocked${index}.js')`);
  }
  assert.deepEqual(extractImports(lines.join("\n"), "barrel.js"), expected.sort());
});

test("shared declaration scan contexts cap aggregate malformed-source work", () => {
  const source = `export function broken() {\n${"x".repeat(100_000)}`;
  const block = { scope: "symbol", end: 0 };
  const scanContext = createDeclarationScanContext(source);

  assert.equal(findAttachedDeclaration(source, block, "broken.js", scanContext)?.symbol, "broken");
  assert.equal(findAttachedDeclaration(source, block, "broken.js", scanContext)?.symbol, "broken");
  assert.equal(findAttachedDeclaration(source, block, "broken.js", scanContext), null);
});

test("declaration bodies include type annotations and initializers that contain braces", () => {
  const fixtures = [
    {
      name: "TypeScript object parameter",
      filePath: "src/authorize.ts",
      signature: "export function authorize(user: { role: string }): boolean",
      first: `${card("api.authorize")}export function authorize(user: { role: string }): boolean {\n  return true;\n}\n`,
      second: `${card("api.authorize")}export function authorize(user: { role: string }): boolean {\n  return false;\n}\n`,
    },
    {
      name: "TSX destructured props",
      filePath: "src/page.tsx",
      signature: "export default function Page({ id }: { id: string })",
      first: `${card("ui.page")}export default function Page({ id }: { id: string }) {\n  return null;\n}\n`,
      second: `${card("ui.page")}export default function Page({ id }: { id: string }) {\n  return String(id);\n}\n`,
    },
    {
      name: "TypeScript object return type",
      filePath: "src/status.ts",
      signature: "export function make(): { ok: boolean }",
      first: `${card("api.status.make")}export function make(): { ok: boolean } {\n  return { ok: true };\n}\n`,
      second: `${card("api.status.make")}export function make(): { ok: boolean } {\n  return { ok: false };\n}\n`,
    },
    {
      name: "TypeScript generic constraint",
      filePath: "src/pick.ts",
      signature: "export function pick<T extends {}>(value: T)",
      first: `${card("util.pick")}export function pick<T extends {}>(value: T) {\n  return value;\n}\n`,
      second: `${card("util.pick")}export function pick<T extends {}>(value: T) {\n  return [value];\n}\n`,
    },
    {
      name: "Go empty interface parameter",
      filePath: "src/handle.go",
      signature: "func Handle(payload interface{}) error",
      first: `${card("api.handle")}func Handle(payload interface{}) error {\n\treturn nil\n}\n`,
      second: `${card("api.handle")}func Handle(payload interface{}) error {\n\treturn failed("payload")\n}\n`,
    },
    {
      name: "TypeScript control parameter",
      filePath: "src/control.ts",
      signature: "export function control(user: string): boolean",
      first: `${card("api.control")}export function control(user: string): boolean {\n  return true;\n}\n`,
      second: `${card("api.control")}export function control(user: string): boolean {\n  return false;\n}\n`,
    },
    {
      name: "multiline TypeScript return type",
      filePath: "src/build.ts",
      signature: "export function build(): { ok: boolean; }",
      first: `${card("api.build")}export function build(): {\n  ok: boolean;\n} {\n  return { ok: true };\n}\n`,
      second: `${card("api.build")}export function build(): {\n  ok: boolean;\n} {\n  return { ok: false };\n}\n`,
    },
    {
      name: "TypeScript arrow with object body",
      filePath: "src/arrow.ts",
      signature: "export const build = (): { ok: boolean }",
      first: `${card("api.arrow.build")}export const build = (): { ok: boolean } => {\n  return { ok: true };\n};\n`,
      second: `${card("api.arrow.build")}export const build = (): { ok: boolean } => {\n  return { ok: false };\n};\n`,
    },
  ];

  for (const fixture of fixtures) {
    const [firstBlock] = parseLlmnavBlocks(fixture.first, fixture.filePath);
    const [secondBlock] = parseLlmnavBlocks(fixture.second, fixture.filePath);
    const firstDeclaration = findAttachedDeclaration(fixture.first, firstBlock, fixture.filePath);
    const secondDeclaration = findAttachedDeclaration(fixture.second, secondBlock, fixture.filePath);
    assert.equal(firstDeclaration.endOffset, fixture.first.lastIndexOf("}") + 1, fixture.name);
    assert.equal(firstDeclaration.signature, fixture.signature, fixture.name);
    assert.equal(secondDeclaration.signature, fixture.signature, fixture.name);
    assert.notEqual(firstDeclaration.bodyHash, secondDeclaration.bodyHash, fixture.name);
  }
});

test("declaration boundaries stop before statement continuations and following declarations", () => {
  const fixtures = [
    {
      filePath: "src/asi-call.ts",
      source: `${card("parser.asi.call")}export function first() {\n  return 1;\n}\n(async () => {\n  waitForFirst();\n})();\n`,
      expectedEnd: "  return 1;\n}",
    },
    {
      filePath: "src/asi-array.ts",
      source: `${card("parser.asi.array")}export function second() {\n  return 2;\n}\n;[3].forEach((value) => {\n  recordSecond(value);\n});\n`,
      expectedEnd: "  return 2;\n}",
    },
    {
      filePath: "src/flags.ts",
      source: `${card("parser.flags")}export type Flags = { ok: boolean };\nexport const afterTypeAlias = 1;\n`,
      expectedEnd: "{ ok: boolean }",
    },
    {
      filePath: "src/shape.ts",
      source: `${card("parser.shape")}export interface Shape {\n  area(): number;\n}\nexport function area(shape: Shape) {\n  return shape.area();\n}\n`,
      expectedEnd: "  area(): number;\n}",
    },
  ];

  for (const fixture of fixtures) {
    const [block] = parseLlmnavBlocks(fixture.source, fixture.filePath);
    const declaration = findAttachedDeclaration(fixture.source, block, fixture.filePath);
    const expectedEnd = fixture.source.indexOf(fixture.expectedEnd) + fixture.expectedEnd.length;
    assert.equal(declaration.endOffset, expectedEnd, fixture.filePath);
    assert.match(declaration.bodyHash, /^[a-f0-9]{64}$/u, fixture.filePath);
  }
});

test("object-typed declaration bodies surface as body changes in generation reports", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-declaration-object-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"declaration-object-fixture"}\n');
  await mkdir(path.join(root, "src"), { recursive: true });
  const sourcePath = path.join(root, "src", "authorize.ts");
  await writeFile(sourcePath, `${card("api.authorize.user")}export function authorize(user: { role: string }): boolean {\n  return true;\n}\n`);
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);

  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("return true;", "return user.role === \"admin\";"));
  const generated = await generateProject(root);
  const change = generated.changedCards.find((item) => item.id === "api.authorize.user");
  assert.ok(change);
  assert.deepEqual(change.dimensions, ["body"]);
  assert.equal(generated.affectedBoundaries.some((item) => item.id === "api.authorize.user"), true);
});

function card(id) {
  return `/* llmnav/1 symbol\nid=${id}\nrole=Execute the named contract boundary deterministically.\nsearch=${id.replaceAll(".", " ")}|contract boundary\nstability=contract\n*/\n`;
}

test("MTS and CTS declarations and imports use the TypeScript parser", () => {
  for (const extension of ["ts", "mts", "cts", "d.ts", "d.mts", "d.cts"]) {
    const file = `src/load.${extension}`;
    const source = `${card("api.user.load")}export function loadUser(): string { return "ok"; }\nimport value from "./value.mjs";\n`;
    const [block] = parseLlmnavBlocks(source, file);
    const declaration = findAttachedDeclaration(source, block, file);
    assert.equal(declaration?.symbol, "loadUser", file);
    assert.equal(declaration.language, "typescript", file);
    assert.deepEqual(extractImports(source, file), ["./value.mjs"], file);
  }
});
