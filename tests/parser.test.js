import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { canonicalizeSource, formatLlmnavBlock, parseLlmnavBlocks } from "../src/parser.js";
import { findAttachedDeclaration } from "../src/declaration.js";

test("canonicalization assembles many edits without repeatedly slicing the whole source", (context) => {
  const source = Array.from({ length: 500 }, (_, index) =>
    `// ${"x".repeat(512)}\n/* llmnav/1 module\nrole=Own a stable fixture boundary.\nid=fixture.card.${index}\nstability=architecture\n*/\n`).join("");
  const originalSlice = String.prototype.slice;
  let slicedUnits = 0;
  let result;
  try {
    String.prototype.slice = function (...args) {
      const value = originalSlice.apply(this, args);
      slicedUnits += value.length;
      return value;
    };
    result = canonicalizeSource(source, "many-cards.js");
  } finally {
    String.prototype.slice = originalSlice;
  }
  assert.equal(result.changed, true);
  assert.equal(result.blocks.length, 500);
  assert.deepEqual(result.errors, []);
  assert.ok(slicedUnits < source.length * 4, `Sliced ${slicedUnits} units for ${source.length}-unit source`);
  assert.equal(canonicalizeSource(result.source, "many-cards.js").changed, false);
  context.diagnostic(JSON.stringify({ sourceUnits: source.length, slicedUnits }));
});

test("canonicalization preserves untouched spans, invalid cards and mixed comment styles", () => {
  const unchanged = "/* llmnav/1 module\nid=fixture.stable\nrole=Own an unchanged boundary.\nstability=architecture\n*/";
  const unknown = "/* llmnav/1 module\nid=fixture.unknown\ncustom=preserve this field\n*/";
  const duplicate = "/* llmnav/1 module\nid=fixture.first\nid=fixture.second\n*/";
  const pairs = [
    ["/* llmnav/1 module\n\nrole=  Own a block boundary.  \nid=fixture.block\n*/",
      "/* llmnav/1 module\nid=fixture.block\nrole=Own a block boundary.\n*/"],
    [unknown, unknown],
    ["  // llmnav/1 module\n  // role=Own a line boundary.\n  // id=fixture.line\n  // /llmnav\n",
      "  // llmnav/1 module\n  // id=fixture.line\n  // role=Own a line boundary.\n  // /llmnav\n"],
    [duplicate, duplicate],
    [unchanged, unchanged],
    ["<!-- llmnav/1 module\nrole=Own an HTML boundary.\nid=fixture.html\n-->",
      "<!-- llmnav/1 module\nid=fixture.html\nrole=Own an HTML boundary.\n-->"],
  ];
  for (const newline of ["\n", "\r\n"]) {
    const assemble = (side) => ("const before = 1;\n" + pairs.map((pair) => pair[side]).join("\nconst between = 2;\n") + "\nconst after = 3;").replaceAll("\n", newline);
    const result = canonicalizeSource(assemble(0), "mixed.js");
    assert.equal(result.source, assemble(1));
    assert.equal(result.changed, true);
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.some((error) => error.message === "Unknown field custom must be fixed before formatting."));
    assert.ok(result.errors.some((error) => error.message === "Duplicate scalar field id must be fixed before formatting."));
    const again = canonicalizeSource(result.source, "mixed.js");
    assert.equal(again.changed, false);
    assert.deepEqual(again.errors, result.errors.map((error) => ({ ...error, line: error.line - 1 })));
  }
});

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

test("line-card scanning preserves EOF offsets across comment styles and newlines", () => {
  for (const [prefix, extension] of [["//", "ts"], ["#", "py"], ["--", "sql"]]) {
    for (const newline of ["\n", "\r\n"]) {
      for (const terminated of [false, true]) {
        const lines = ["llmnav/1 file", "id=fixture.eof", "role=Own EOF parsing.", "stability=architecture"];
        if (terminated) lines.push("/llmnav");
        const source = lines.map((line) => `${prefix} ${line}`).join(newline);
        const [block] = parseLlmnavBlocks(source, `fixture.${extension}`);
        assert.equal(block.card.id, "fixture.eof");
        assert.equal(block.start, 0);
        assert.equal(block.end, source.length);
        assert.equal(block.raw, source);
        assert.equal(block.syntaxErrors.length, terminated ? 0 : 1);
      }
    }
  }
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

test("JavaScript regex quotes do not hide later cards or expose regex contents", () => {
  const card = "/* llmnav/1 module\nid=regex.real\nrole=Own the real boundary.\nstability=architecture\n*/";
  const prefixes = [
    "const expression = /'/;",
    "const expression = /[\"'`]/;",
    "const expression = /='([^']*)'/g;",
    "const expression = /[/'`]/;",
    String.raw`const expression = /'\/'/g;`,
    "function expression() { return /'/; }",
    "const expression = (/* ordinary comment */ /'/);",
    "if (true) /'/ .test('value');",
    "const expression = 12 / 3 / 2;",
    "const expression = {value: 1} / 2;",
  ];
  // Syntax validation is independent of the navigation parser under test.
  for (const prefix of prefixes) {
    const source = `${prefix}\n${card}\n`;
    assert.doesNotThrow(() => new Script(source), prefix);
    for (const extension of ["js", "ts", "mts", "cts", "mjs", "cjs", "jsx", "tsx"]) {
      assert.deepEqual(parseLlmnavBlocks(source, `fixture.${extension}`).map((block) => block.card.id), ["regex.real"], prefix);
    }
  }
  const fake = "const expression = /[<!-- llmnav/1 file -->]/;";
  assert.doesNotThrow(() => new Script(fake));
  assert.deepEqual(parseLlmnavBlocks(fake, "fixture.js"), []);
  for (const prefix of ["const value = object.return /", "const of = 4; const value = of /", "const value = {a: 1} /"]) {
    const source = `${prefix} ${card} 2;`;
    assert.doesNotThrow(() => new Script(source));
    assert.deepEqual(parseLlmnavBlocks(source, "fixture.js").map((block) => block.card.id), ["regex.real"]);
  }
  for (const prefix of ["const view = <div></div>;", "const view = <div />;", "const view = <></>;"]) {
    assert.deepEqual(parseLlmnavBlocks(`${prefix}\n${card}`, "fixture.tsx").map((block) => block.card.id), ["regex.real"]);
  }
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

test("repeated unterminated card openings cannot monopolize the parser", (context) => {
  for (const [header, filePath, message] of [
    ["/* llmnav/1 module\n", "broken.ts", "Block-comment LLMNav blocks must end with */."],
    ["<!-- llmnav/1 module\n", "broken.html", "HTML-comment LLMNav blocks must end with -->."],
  ]) {
    const source = header.repeat(50_000);
    const started = process.hrtime.bigint();
    // VM timeout interrupts a synchronous regexp too; a test timer cannot do that.
    const blocks = new Script("parseLlmnavBlocks(source, filePath)").runInNewContext(
      { parseLlmnavBlocks, source, filePath }, { timeout: 3000 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].raw, source);
    assert.ok(blocks[0].syntaxErrors.some(error => error.message === message));
    context.diagnostic(JSON.stringify({ filePath, openings: 50_000, sourceBytes: Buffer.byteLength(source), elapsedMs }));
  }
});

test("terminated cards keep the nearest closing marker and skip consumed openings", () => {
  for (const [open, close, filePath] of [["/*", "*/", "nested.ts"], ["<!--", "-->", "nested.html"]]) {
    const first = `${open} LLMNAV/1 MODULE\r\nid=fixture.first\r\n${open} llmnav/1 symbol\r\n${close}`;
    const second = `${open} llmnav/1 module\nid=fixture.second\n${close}`;
    const source = `${first}\n${second}`;
    const blocks = parseLlmnavBlocks(source, filePath);
    assert.deepEqual(blocks.map(block => block.card.id), ["fixture.first", "fixture.second"]);
    assert.deepEqual(blocks.map(block => block.raw), [first, second]);
    assert.deepEqual(blocks.map(block => block.start), [0, first.length + 1]);
    assert.deepEqual(blocks.map(block => block.end), [first.length, source.length]);
  }
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

test("Go raw strings ending in backslash do not hide following cards", () => {
  const source = [
    "package fixture",
    "const directory = `C:\\`",
    "",
    "/* llmnav/1 module",
    "id=fixture.real",
    "role=Own the real Go boundary.",
    "stability=architecture",
    "*/",
    "",
  ].join("\n");
  assert.deepEqual(parseLlmnavBlocks(source, "fixture.go").map((block) => block.card.id), ["fixture.real"]);
  assert.equal(canonicalizeSource(source, "fixture.go").source, source);
});

test("Rust raw strings hide internal quotes and card-shaped text", () => {
  const source = [
    'const SAMPLE: &str = r#"quoted "',
    "/* llmnav/1 module",
    "role=This text belongs to a raw string.",
    "id=fixture.fake",
    "stability=architecture",
    "*/",
    '"#;',
    "/* llmnav/1 module",
    "id=fixture.real",
    "role=Own the real Rust boundary.",
    "stability=architecture",
    "*/",
    "",
  ].join("\n");
  assert.deepEqual(parseLlmnavBlocks(source, "fixture.rs").map((block) => block.card.id), ["fixture.real"]);
  assert.equal(canonicalizeSource(source, "fixture.rs").source, source);
  const byteString = source.replace('r#"quoted "', 'br##"quoted "').replace('"#;', '"##;');
  assert.deepEqual(parseLlmnavBlocks(byteString, "fixture.rs").map((block) => block.card.id), ["fixture.real"]);
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

test("enforces the card limit before materializing excess complete blocks", () => {
  const source = "/* llmnav/1 file\nid=fixture.repeated\nstability=architecture\n*/\n".repeat(10_001);
  assert.throws(() => parseLlmnavBlocks(source, "dense-blocks.js"), /block parser limit/u);
});

test("classifies nested HTML marker openings without rescanning parsed intervals", () => {
  const source = `${"<!-- llmnav/1 file\n".repeat(10_001)}-->\n`;
  const started = process.hrtime.bigint();
  const blocks = parseLlmnavBlocks(source, "dense-blocks.html");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  assert.equal(blocks.length, 1);
  assert.ok(elapsedMs < 3_000, `nested-marker parse took ${elapsedMs.toFixed(1)}ms`);
});
