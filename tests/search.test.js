import assert from "node:assert/strict";
import test from "node:test";
import { queryIndex, queryIndexLegacy, queryPreparedIndex, tokenize } from "../src/search.js";
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
  assert.deepEqual(results.find(({ id }) => id === "z.seed").reasons, ['alias="quuxzz"']);
  assert.equal(results.find(({ id }) => id === "z.seed").card, cards[0]);
  assert.deepEqual(input, before);
  assert.equal(metrics.idDocumentsScanned, 8);
  assert.equal(metrics.phraseDocumentsScanned, 8);
  assert.equal(metrics.postingVisits, 0);
});

test("bounded ranking matches full sorting and preserves relation seeds across result limits", () => {
  const cards = Array.from({ length: 300 }, (_, position) => {
    const number = (position * 137) % 300;
    return {
      id: `feature.n${String(number).padStart(3, "0")}`,
      role: "cobalt ".repeat(1 + number % 7),
      excludes: number % 2 ? ["external billing"] : [],
      rel: [`workflow>feature.n${String((number + 1) % 300).padStart(3, "0")}`],
    };
  });
  const input = { cards }, before = structuredClone(input);
  const { searchIndex } = buildInvertedIndex(input);
  const lexicon = { aliases: { aliaszz: cards.map(card => card.id).reverse() } };
  for (const query of ["cobalt", "aliaszz", "excludes: billing", "unmatchedzz"]) {
    for (const top of [1, 3, 7, 100]) {
      const expected = queryIndexLegacy(input, query, { top, lexicon });
      const sort = Array.prototype.sort;
      let sortedResults = 0, actual;
      try {
        Array.prototype.sort = function (...args) {
          if (this[0]?.card || this[0]?.value?.card) sortedResults += this.length;
          return Reflect.apply(sort, this, args);
        };
        actual = queryPreparedIndex(input, searchIndex, query, { top, lexicon });
      } finally { Array.prototype.sort = sort; }
      assert.deepEqual(actual, expected, `${query}, top=${top}`);
      assert.ok(sortedResults <= top + 3, `${query}, top=${top}: sorted ${sortedResults} results`);
    }
  }
  assert.deepEqual(input, before);
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

test("Latin alias boundaries and CJK substrings agree across search implementations", () => {
  const input = { cards: [{ id: "security.login", role: "Verify credentials." }] };
  const lexicon = { aliases: { auth: "security.login", "권한": "security.login", "sign-in": "security.login", "node.js": "security.login" } };
  for (const search of [queryIndex, queryIndexLegacy]) {
    for (const query of ["author biographies", "authentication", "oauth", "auths", "auth_thing"]) {
      assert.equal(search(input, query, { lexicon }).length, 0, query);
    }
    for (const query of ["AUTH!", "fix auth-token", "author auth", "권한문제", "use sign-in", "node.js!"]) {
      assert.ok(search(input, query, { lexicon })[0].reasons.some(reason => reason.startsWith("alias=")), query);
    }
  }
});

test("excluded scope requires an explicit excludes query and never seeds relations", () => {
  const input = { cards: [
    { id: "security.login", role: "Verify credentials.", excludes: ["billing"], rel: ["workflow>security.other"] },
    { id: "security.other", role: "Another component." },
  ] };
  for (const search of [queryIndex, queryIndexLegacy]) {
    assert.deepEqual(search(input, "billing"), []);
    assert.deepEqual(search(input, "excludes:"), []);
    assert.deepEqual(search(input, "excludes: bill"), []);
    const results = search(input, "excludes: billing");
    assert.deepEqual(results.map(result => result.id), ["security.login"]);
    assert.deepEqual(results[0].reasons, ['excludes="billing"']);
    assert.equal(search(input, "Verify billing")[0].id, "security.login");
  }
});
