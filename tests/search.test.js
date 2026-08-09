import assert from "node:assert/strict";
import test from "node:test";
import { queryIndex, tokenize } from "../src/search.js";

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


test("clamps invalid result limits", () => {
  const results = queryIndex(index, "refresh token", { top: 0, lexicon: { aliases: {} } });
  assert.equal(results.length, 1);
});
