import assert from "node:assert/strict";
import test from "node:test";
import { getAgentToolDefinitions, executeAgentOperation } from "../src/agent-protocol.js";
import { selectAuditCandidates } from "../src/audit.js";
import { buildInvertedIndex } from "../src/inverted-index.js";
import { AUDIT_LIMITS, SEARCH_LIMITS } from "../src/policy.js";
import { queryIndexLegacy, queryPreparedIndex } from "../src/search.js";

function buildIndex(count) {
  return {
    repositoryId: "example/repo",
    cards: Array.from({ length: count }, (_, position) => ({
      id: `auth.session.rotate${position}`,
      role: "Rotate one refresh-token family atomically.",
      search: ["refresh token", "token rotation"],
      invariant: [],
      rel: [],
      location: { path: `src/auth/rotate${position}.ts`, symbol: "rotateSession", startLine: 1, declarationLine: 10 },
    })),
  };
}

test("tool input schemas expose the shared policy limits", () => {
  const definitions = new Map(getAgentToolDefinitions().map((definition) => [definition.name, definition]));
  const queryTop = definitions.get("llmnav_query").inputSchema.properties.top;
  assert.deepEqual(
    { default: queryTop.default, minimum: queryTop.minimum, maximum: queryTop.maximum },
    { default: SEARCH_LIMITS.top.default, minimum: SEARCH_LIMITS.top.minimum, maximum: SEARCH_LIMITS.top.maximum },
  );
  const context = definitions.get("llmnav_context").inputSchema.properties;
  for (const name of ["depth", "budget", "maxEdges"]) {
    assert.deepEqual(
      { default: context[name].default, minimum: context[name].minimum, maximum: context[name].maximum },
      { ...SEARCH_LIMITS[name] },
    );
  }
  const auditTop = definitions.get("llmnav_audit").inputSchema.properties.top;
  assert.deepEqual(
    { default: auditTop.default, minimum: auditTop.minimum, maximum: auditTop.maximum },
    { ...AUDIT_LIMITS.top },
  );
  assert.ok(Object.isFrozen(SEARCH_LIMITS.top));
  assert.ok(Object.isFrozen(AUDIT_LIMITS.top));
});

test("prepared and legacy queries share the default result limit", () => {
  const index = buildIndex(10);
  const { searchIndex } = buildInvertedIndex(index);
  assert.equal(queryPreparedIndex(index, searchIndex, "refresh token").length, SEARCH_LIMITS.top.default);
  assert.equal(queryIndexLegacy(index, "refresh token").length, SEARCH_LIMITS.top.default);
  assert.equal(queryPreparedIndex(index, searchIndex, "refresh token", { top: 100 }).length, 10);
});

test("audit candidate selection defaults to the shared limit", () => {
  const result = {
    candidates: Array.from({ length: 15 }, (_, position) => ({
      path: `src/module${position}.ts`,
      priority: "high",
      score: 100 - position,
    })),
  };
  const selected = selectAuditCandidates(result);
  assert.equal(selected.candidates.length, AUDIT_LIMITS.top.default);
  assert.equal(selected.matched, 15);
  assert.equal(selected.truncated, true);
  assert.equal(selectAuditCandidates(result, "low", 15).truncated, false);
});

test("agent operation defaults come from the same policy", async () => {
  const session = {
    query: (task, options) => ({ task, options }),
    context: (id, options) => ({ id, options }),
  };
  const query = await executeAgentOperation(".", "llmnav_query", { task: "refresh token" }, { session });
  assert.equal(query.ok, true);
  assert.equal(query.data.options.top, SEARCH_LIMITS.top.default);
  const context = await executeAgentOperation(".", "llmnav_context", { id: "auth.session.rotate" }, { session });
  assert.equal(context.ok, true);
  assert.deepEqual(context.data.options, {
    depth: SEARCH_LIMITS.depth.default,
    budget: SEARCH_LIMITS.budget.default,
    maxEdges: SEARCH_LIMITS.maxEdges.default,
  });
});
