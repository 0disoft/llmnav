import assert from "node:assert/strict";
import test from "node:test";
import { connectDefinitions } from "../src/analysis.js";

const card = (id, offset, line, symbol = "handle", relativePath = "service.ts") => ({
  relativePath, card: { id, scope: "symbol" }, declaration: { symbol, offset, line },
});
const declaration = (offset, line, extra = {}) => ({
  key: `decl:${offset}`, path: "service.ts", symbol: "handle", kind: "MethodDeclaration",
  offset, line, qualified: `Class${offset}/handle`, ...extra,
});
function connect(records, declarations, language = "typescript", references = []) {
  return connectDefinitions({ config: { repositoryId: "fixture" }, records }, {
    declarations, references, diagnostics: [], compiler: { name: language, version: "fixture" },
  }, language, {});
}

test("compiler card binding indexes repeated method names without quadratic candidate scans", context => {
  const count = 1000;
  let locationReads = 0;
  const records = Array.from({ length: count }, (_, index) => ({
    relativePath: "service.ts", card: { id: `service.handler${index}`, scope: "symbol" },
    declaration: { symbol: "handle",
      get offset() { locationReads++; return index * 10; },
      get line() { locationReads++; return index + 1; },
    },
  }));
  const declarations = Object.freeze(Array.from({ length: count }, (_, index) => declaration(index * 10, index + 1)));
  const graph = connect(records, declarations, "typescript", [{ from: "decl:0", to: "decl:9990", kind: "calls", path: "service.ts", line: 1 }]);
  assert.deepEqual(graph.definitions.map(item => item.id), records.map(record => record.card.id).sort());
  assert.equal(graph.references[0].from, "service.handler0");
  assert.equal(graph.references[0].to, "service.handler999");
  context.diagnostic(JSON.stringify({ cards: count, declarations: count, locationReads }));
  assert.ok(locationReads <= count * 4, `Read candidate locations ${locationReads} times for ${count} cards.`);
});

test("binding indexes preserve OR overlap, ambiguity, fallback priority and module ownership", () => {
  const a = card("service.first", 10, 1), b = card("service.second", 20, 2), c = card("service.signature", 30, 3);
  const module = { relativePath: "service.ts", card: { id: "service.module", scope: "module" } };
  const cases = [
    { records: [a], item: declaration(10, 1), expected: a.card.id },
    { records: [a], item: declaration(10, 99), expected: a.card.id },
    { records: [a], item: declaration(99, 1), expected: a.card.id },
    { records: [a, b, c], item: declaration(10, 2, { signatureOffset: 30, signatureLine: 3 }), expected: null },
    { records: [a, b], item: declaration(10, 1, { signatureOffset: 20, signatureLine: 2 }), expected: a.card.id },
    { records: [a, b], item: declaration(99, 99, { signatureOffset: 20, signatureLine: 2 }), expected: b.card.id },
    { records: [a, b], item: declaration(99, 99, { signatureOffset: 10, signatureLine: 2 }), expected: null },
    { records: [a, a], item: declaration(10, 1), expected: null },
    { records: [a, card("service.duplicate", 10, 1)], item: declaration(10, 1), expected: null },
    { records: [card("service.invalid", NaN, 1)], item: declaration(NaN, 99), expected: null },
    { records: [card("service.invalid", 10, NaN)], item: declaration(99, NaN), expected: null },
    { records: [card("service.other", 10, 1, "other")], item: declaration(10, 1), expected: null },
    { records: [card("service.other", 10, 1, "handle", "other.ts")], item: declaration(10, 1), expected: null },
    { records: [module, a], item: declaration(-1, 1, { kind: "module" }), expected: module.card.id },
    { records: [module, module], item: declaration(-1, 1, { kind: "module" }), expected: null },
    { records: [], item: declaration(0, 1), expected: null },
  ];
  for (const language of ["typescript", "go"]) {
    for (const { records, item, expected } of cases) {
      const actual = connect(records, [item], language).definitions[0].id;
      if (expected === null) assert.match(actual, /^code\.(?:ts|go)\.s[a-f0-9]{32}$/u);
      else assert.equal(actual, expected);
    }
  }
});
