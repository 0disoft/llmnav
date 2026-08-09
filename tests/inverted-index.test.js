import assert from "node:assert/strict";
import test from "node:test";
import { buildInvertedIndex } from "../src/inverted-index.js";
import { queryIndexLegacy, queryPreparedIndex } from "../src/search.js";
import { buildSyntheticIndex, syntheticQueries } from "./helpers/synthetic.js";


test("incremental inverted indexing is byte-identical to a full rebuild", () => {
  const first = buildSyntheticIndex(1200);
  const initial = buildInvertedIndex(first);
  const changed = structuredClone(first);
  changed.cards[417].role = `${changed.cards[417].role} Reject duplicate work.`;
  changed.cards.splice(900, 1);
  changed.cards.push({ ...structuredClone(changed.cards[899]), id: "domain999.feature999.action999999" });

  const incremental = buildInvertedIndex(changed, initial.searchIndex);
  const full = buildInvertedIndex(changed);
  assert.deepEqual(incremental.searchIndex, full.searchIndex);
  assert.equal(incremental.stats.indexedCards, 2);
  assert.equal(incremental.stats.removedCards, 1);
  assert.equal(incremental.stats.reusedCards, changed.cards.length - 2);
});


test("prepared search preserves legacy ranking on a large synthetic index", () => {
  const index = buildSyntheticIndex(3000);
  const { searchIndex } = buildInvertedIndex(index);
  for (const item of syntheticQueries(3000, 100)) {
    const legacy = queryIndexLegacy(index, item.query, { top: 5, lexicon: { aliases: {} } });
    const prepared = queryPreparedIndex(index, searchIndex, item.query, { top: 5, lexicon: { aliases: {} } });
    assert.deepEqual(
      prepared.map((result) => [result.id, result.score]),
      legacy.map((result) => [result.id, result.score]),
      item.query,
    );
    assert.equal(prepared[0]?.id, item.expected);
  }
});


test("prepared queries do not tokenize card documents", () => {
  const index = buildSyntheticIndex(1000);
  const { searchIndex } = buildInvertedIndex(index);
  const metrics = {};
  const [result] = queryPreparedIndex(index, searchIndex, "operation code000777", {
    top: 5,
    lexicon: { aliases: {} },
    metrics,
  });
  assert.equal(result.id, "domain000.feature077.action000777");
  assert.equal(metrics.documentTokenizations, 0);
  assert.ok(metrics.postingVisits > 0);
});

test("inverted index bytes do not depend on card traversal order", () => {
  const ordered = buildSyntheticIndex(700);
  const reversed = { ...ordered, cards: [...ordered.cards].reverse() };
  const zigzag = {
    ...ordered,
    cards: ordered.cards.filter((_, index) => index % 2 === 0)
      .concat(ordered.cards.filter((_, index) => index % 2 === 1).reverse()),
  };
  const expected = JSON.stringify(buildInvertedIndex(ordered).searchIndex);
  assert.equal(JSON.stringify(buildInvertedIndex(reversed).searchIndex), expected);
  assert.equal(JSON.stringify(buildInvertedIndex(zigzag).searchIndex), expected);
});
