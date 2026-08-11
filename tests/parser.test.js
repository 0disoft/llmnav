import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeSource, formatLlmnavBlock, parseLlmnavBlocks } from "../src/parser.js";
import { findAttachedDeclaration } from "../src/declaration.js";

test("parses and canonicalizes an indented block card", () => {
  const source = `export function outer() {\n  /* llmnav/1 symbol\n  stability=contract\n  role=Rotate one token family.\n  search=refresh token|token rotation\n  id=auth.session.rotate\n  */\n  function rotate() {}\n}\n`;
  const blocks = parseLlmnavBlocks(source, "session.ts");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].card.id, "auth.session.rotate");
  assert.deepEqual(blocks[0].card.search, ["refresh token", "token rotation"]);

  const formatted = canonicalizeSource(source, "session.ts");
  assert.equal(formatted.changed, true);
  assert.match(formatted.source, /id=auth\.session\.rotate\n  role=/u);
  assert.match(formatted.source, /\n  stability=contract\n  \*\//u);
});

test("parses explicit line-comment cards", () => {
  const source = `# llmnav/1 symbol\n# id=auth.session.rotate\n# role=Rotate one token family.\n# search=refresh token|token rotation\n# stability=contract\n# /llmnav\ndef rotate():\n    pass\n`;
  const [block] = parseLlmnavBlocks(source, "session.py");
  assert.equal(block.style, "line");
  assert.equal(block.prefix, "#");
  assert.equal(block.syntaxErrors.length, 0);
  assert.equal(formatLlmnavBlock(block).trimEnd().split("\n").at(-1), "# /llmnav");
  assert.equal(findAttachedDeclaration(source, block, "session.py")?.symbol, "rotate");
});

test("reports an unterminated line-comment card", () => {
  const source = `// llmnav/1 file\n// id=api.users\n// role=Expose user lookup.\n// stability=contract\nconst x = 1;\n`;
  const [block] = parseLlmnavBlocks(source, "users.ts");
  assert.equal(block.syntaxErrors.length, 1);
});

test("ignores LLMNav-looking comments inside source string literals", () => {
  const source = [
    "const fixture = `/* llmnav/1 symbol",
    "id=fixture.fake.card",
    "role=This text belongs to a test fixture string.",
    "search=fake card|fixture string",
    "stability=contract",
    "*/`;",
    "const lineFixture = `# llmnav/1 symbol\\n# id=fixture.line.card\\n# /llmnav`;",
  ].join("\\n");
  assert.deepEqual(parseLlmnavBlocks(source, "fixture.test.js"), []);
});

test("line-card formatting preserves the newline before the declaration", () => {
  const source = `# llmnav/1 symbol\n# stability=contract\n# role=Rotate one token family.\n# search=refresh token|token rotation\n# id=auth.session.rotate\n# /llmnav\ndef rotate():\n    pass\n`;
  const first = canonicalizeSource(source, "session.py");
  assert.match(first.source, /# \/llmnav\ndef rotate\(\):/u);
  const second = canonicalizeSource(first.source, "session.py");
  assert.equal(second.changed, false);
});

test("reports an unterminated block-comment card", () => {
  const source = `/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate one session.\nstability=contract\n`;
  const [block] = parseLlmnavBlocks(source, "session.ts");
  assert.equal(block.scope, "symbol");
  assert.equal(block.syntaxErrors[0].message, "Block-comment LLMNav blocks must end with */.");
});

test("does not skip a later card after an unterminated line card", () => {
  const source = `// llmnav/1 file\n// id=broken.file.card\nconst boundary = true;\n\n/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate one session.\nstability=contract\n*/\nexport function rotateSession() {}\n`;
  const blocks = parseLlmnavBlocks(source, "session.ts");
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].syntaxErrors[0].message, /must end with \/\/ \/llmnav/u);
  assert.equal(blocks[1].card.id, "auth.session.rotate");
});

test("ignores LLMNav-looking block syntax inside an ordinary comment", () => {
  const source = `// Example only: /* llmnav/1 symbol\n// id=fake.card\n// */\nexport const real = true;\n`;
  assert.deepEqual(parseLlmnavBlocks(source, "fixture.ts"), []);
});

test("formatter refuses to erase unknown fields", () => {
  const source = `/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate one session.\npath=src/session.ts\nstability=contract\n*/\nexport function rotateSession() {}\n`;
  const result = canonicalizeSource(source, "session.ts");
  assert.equal(result.changed, false);
  assert.equal(result.source, source);
  assert.match(result.errors[0].message, /Unknown field path/u);
});

test("formatter refuses duplicate scalar fields", () => {
  const source = `/* llmnav/1 symbol\nid=auth.session.rotate\nid=auth.session.replace\nrole=Rotate one session.\nstability=contract\n*/\nexport function rotateSession() {}\n`;
  const result = canonicalizeSource(source, "session.ts");
  assert.equal(result.changed, false);
  assert.match(result.errors[0].message, /Duplicate scalar field id/u);
});

test("Rust lifetimes before a card are not treated as unterminated strings", () => {
  const source = `pub fn borrow<'a>(value: &'a str) -> &'a str { value }\n\n/* llmnav/1 symbol\nid=rust.borrow.copy\nrole=Copy one borrowed value into owned storage.\nsearch=borrowed value|owned storage\nstability=contract\n*/\npub fn copy_value<'a>(value: &'a str) -> String { value.to_owned() }\n`;
  const blocks = parseLlmnavBlocks(source, "borrow.rs");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].card.id, "rust.borrow.copy");
  assert.equal(findAttachedDeclaration(source, blocks[0], "borrow.rs")?.symbol, "copy_value");
});

test("Rust character literals still hide LLMNav-looking text", () => {
  const source = `const MARKER: char = '/';\nconst TEXT: &str = "/* llmnav/1 symbol\\nid=fake.rust.card\\n*/";\n`;
  assert.deepEqual(parseLlmnavBlocks(source, "borrow.rs"), []);
});

test("parses marker-dense source with one lexical pass", () => {
  const fake = "const value = '/* llmnav/1 symbol */';\n".repeat(20_000);
  const source = `${fake}/* llmnav/1 module\nid=fixture.real\nrole=Own the real fixture boundary.\nstability=architecture\n*/\n`;
  const started = process.hrtime.bigint();
  const blocks = parseLlmnavBlocks(source, "fixture.js");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  assert.deepEqual(blocks.map((block) => block.card.id), ["fixture.real"]);
  assert.ok(elapsedMs < 2_000, `marker-dense parse took ${elapsedMs.toFixed(1)}ms`);
});

test("rejects source files above the parser byte budget", () => {
  const source = "x".repeat(16 * 1024 * 1024 + 1);
  assert.throws(() => parseLlmnavBlocks(source, "oversized.js"), /parser byte limit/u);
});
