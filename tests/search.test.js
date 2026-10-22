import assert from "node:assert/strict";
import test from "node:test";
import { queryIndex, queryPreparedIndex, tokenize } from "../src/search.js";
import { buildInvertedIndex } from "../src/inverted-index.js";

const index = {
  cards: [
    {
      id: "auth.session.rotate",
      role: "Rotate one refresh-token family atomically and reject replayed tokens.",
      search: ["refresh token", "token rotation", "replay detection"],
      invariant: ["Replay revokes the entire token family."],
      rel: ["workflow>auth.session.revoke-family"],
      location: { path: "src/auth/rotate.ts", symbol: "rotateSession", startLine: 1, declarationLine: 10 },
    },
    {
      id: "auth.session.revoke-family",
      role: "Revoke every token in one session family.",
      search: ["session revocation", "token family"],
      invariant: [],
      rel: [],
      location: { path: "src/auth/revoke.ts", symbol: "revokeFamily", startLine: 1, declarationLine: 8 },
    },
    {
      id: "billing.credit.reserve",
      role: "Reserve credits before an external generation job starts.",
      search: ["credit hold", "reserve credits"],
      invariant: [],
      rel: [],
      location: { path: "src/billing/reserve.ts", symbol: "reserveCredits", startLine: 1, declarationLine: 5 },
    },
  ],
};

test("ranks matching semantic cards", () => {
  const [result] = queryIndex(index, "replayed refresh token", { top: 3, lexicon: { aliases: {} } });
  assert.equal(result.id, "auth.session.rotate");
});

test("routes multilingual aliases to stable IDs", () => {
  const [result] = queryIndex(index, "리프레시 토큰 재사용 공격 수정", {
    top: 3,
    lexicon: { aliases: { "토큰 재사용 공격": "auth.session.rotate" } },
  });
  assert.equal(result.id, "auth.session.rotate");
  assert.ok(result.reasons.some((reason) => reason.startsWith("alias=")));
});

test("tokenizer emits CJK n-grams", () => {
  const tokens = tokenize("세션갱신");
  assert.ok(tokens.includes("세션"));
  assert.ok(tokens.includes("세션갱"));
});


test("detaches public results from the index snapshot", () => {
  const [result] = queryIndex(index, "replayed refresh token", { top: 3, lexicon: { aliases: {} } });
  assert.notEqual(result.card, index.cards[0]);
  result.card.role = "mutated by the caller";
  result.location.path = "mutated.ts";
  assert.equal(index.cards[0].role, "Rotate one refresh-token family atomically and reject replayed tokens.");
  assert.equal(index.cards[0].location.path, "src/auth/rotate.ts");
  const [again] = queryIndex(index, "replayed refresh token", { top: 3, lexicon: { aliases: {} } });
  assert.equal(again.role, index.cards[0].role);
});

test("clamps invalid result limits", () => {
  const results = queryIndex(index, "refresh token", { top: 0, lexicon: { aliases: {} } });
  assert.equal(results.length, 1);
});

test("caller-owned indexes reflect card edits, additions, and removals", () => {
  const mutable = structuredClone(index);
  assert.equal(queryIndex(mutable, "qzxalpha").length, 0);
  mutable.cards[0].role = "Reserve qzxalpha credits before dispatch.";
  assert.equal(queryIndex(mutable, "qzxalpha")[0].id, mutable.cards[0].id);
  mutable.cards[0].role = "Reserve qzxbeta credits before dispatch.";
  assert.equal(queryIndex(mutable, "qzxalpha").length, 0);
  assert.equal(queryIndex(mutable, "qzxbeta")[0].id, mutable.cards[0].id);
  mutable.cards.push({ ...structuredClone(mutable.cards[0]), id: "demo.added", role: "Reserve qzxgamma credits." });
  assert.equal(queryIndex(mutable, "qzxgamma")[0].id, "demo.added");
  mutable.cards.pop();
  assert.equal(queryIndex(mutable, "qzxgamma").length, 0);
});

test("prepared queries do not retain stale token offsets for caller-owned search indexes", () => {
  const mutable = structuredClone(index);
  const { searchIndex } = buildInvertedIndex(mutable);
  queryPreparedIndex(mutable, searchIndex, "refresh");
  mutable.cards[0].role = "Reserve qx credits before dispatch.";
  Object.assign(searchIndex, buildInvertedIndex(mutable).searchIndex);
  assert.equal(queryPreparedIndex(mutable, searchIndex, "qx")[0].id, mutable.cards[0].id);
});

test("alias ties choose seeds in card order and display results in ID order", () => {
  const ids = ["z.seed", "y.seed", "x.seed", "a.seed"];
  const cards = ids.map((id) => ({ id, role: "Unrelated", rel: [`workflow>${id.replace("seed", "target")}`] }));
  const targets = ids.map((id) => ({ id: id.replace("seed", "target"), role: "Neighbor" }));
  const input = { cards: [...cards, ...targets] };
  const before = structuredClone(input);
  const { searchIndex } = buildInvertedIndex(input);
  const metrics = {};
  const results = queryPreparedIndex(input, searchIndex, "quuxzz", {
    top: 100,
    lexicon: { aliases: { quuxzz: [...ids, ids[0]], quux: ids[0] } },
    metrics,
  });
  assert.deepEqual(results.map(({ id, score }) => [id, score]), [
    ["a.seed", 500], ["x.seed", 500], ["y.seed", 500], ["z.seed", 500],
    ["x.target", 40], ["y.target", 40], ["z.target", 40],
  ]);
  assert.deepEqual(results.find(({ id }) => id === "z.seed").reasons, ['alias="quuxzz"', 'alias="quux"']);
  assert.equal(results.find(({ id }) => id === "z.seed").card, cards[0]);
  assert.deepEqual(input, before);
  assert.equal(metrics.idDocumentsScanned, 8);
  assert.equal(metrics.phraseDocumentsScanned, 8);
  assert.equal(metrics.postingVisits, 0);
});

test("phrase thresholds and cancellation preserve query metrics", () => {
  const input = { cards: [{ id: "core.abc", role: "abc abcd" }] };
  const { searchIndex } = buildInvertedIndex(input);
  for (const [query, scans, idPhrase, exactPhrase] of [
    ["ab", 0, false, false], ["abc", 0, true, false],
    ["abcd", 1, false, true], ["abcde", 1, false, false],
  ]) {
    const metrics = {};
    const [result] = queryPreparedIndex(input, searchIndex, query, { metrics });
    assert.equal(result?.reasons.includes("semantic ID phrase") ?? false, idPhrase);
    assert.equal(result?.reasons.includes("exact phrase") ?? false, exactPhrase);
    assert.equal(metrics.phraseDocumentsScanned, scans);
  }
  const controller = new AbortController();
  const reason = new Error("cancel query");
  controller.abort(reason);
  const metrics = { untouched: true };
  assert.throws(() => queryPreparedIndex(input, searchIndex, "abc", { metrics, signal: controller.signal }), (error) => error === reason);
  assert.deepEqual(metrics, { untouched: true });
});
