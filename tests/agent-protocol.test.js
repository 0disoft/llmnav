import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_OPERATION_ERROR_CODES,
  executeAgentOperation,
  getAgentToolDefinitions,
} from "../src/agent-protocol.js";
import { AUDIT_PRIORITIES, auditProject } from "../src/audit.js";
import { initializeProject } from "../src/initializer.js";
import { createProjectSession } from "../src/search.js";

test("operation cancellation prevents dispatch and reaches session handlers", async () => {
  const controller = new AbortController();
  let called = 0;
  const session = { query: (task, options) => {
    called += 1;
    assert.equal(options.signal, controller.signal);
    return [];
  } };
  assert.equal((await executeAgentOperation(".", "llmnav_query", { task: "auth" }, { session, signal: controller.signal })).ok, true);
  controller.abort();
  assert.equal((await executeAgentOperation(".", "llmnav_query", { task: "auth" }, { session, signal: controller.signal })).ok, false);
  assert.equal(called, 1);
});

test("publishes stable provider-neutral tool definitions", () => {
  const definitions = getAgentToolDefinitions();
  assert.deepEqual(definitions.map((item) => item.name), [
    "llmnav_query",
    "llmnav_show",
    "llmnav_context",
    "llmnav_check",
    "llmnav_explain",
    "llmnav_audit",
    "llmnav_discover",
  ]);
  assert.ok(definitions.every((item) => item.schemaVersion === 6));
  const auditTool = definitions.find((item) => item.name === "llmnav_audit");
  assert.deepEqual(auditTool.inputSchema.required, []);
  assert.deepEqual(auditTool.inputSchema.properties.priority.enum, [...AUDIT_PRIORITIES]);
  assert.equal(auditTool.inputSchema.properties.top.default, 10);
  assert.ok(definitions.every((item) => item.inputSchema.additionalProperties === false));
  assert.ok(definitions.every((item) => !Object.hasOwn(item.inputSchema.properties, "root")));

  definitions[0].description = "mutated consumer copy";
  assert.notEqual(getAgentToolDefinitions()[0].description, definitions[0].description);
});

test("executes bounded operations through one deterministic envelope", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-agent-protocol-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);

  const query = await executeAgentOperation(root, "llmnav_query", { task: "replayed refresh token", top: 3 });
  assert.equal(query.ok, true);
  assert.equal(query.operation, "query");
  assert.equal(query.data[0].id, "auth.session.rotate");

  const show = await executeAgentOperation(root, "llmnav_show", { id: "auth.session.rotate" });
  assert.equal(show.ok, true);
  assert.equal(show.data.card.id, "auth.session.rotate");

  const packed = await executeAgentOperation(root, "llmnav_context", {
    id: "auth.session.rotate",
    depth: 0,
    budget: 256,
    maxEdges: 0,
  });
  assert.equal(packed.ok, true);
  assert.deepEqual(packed.data.included, ["auth.session.rotate"]);

  const checked = await executeAgentOperation(root, "llmnav_check", { paths: ["src"] });
  assert.equal(checked.ok, true);
  assert.equal(checked.data.counts.error, 0);
  assert.equal(checked.data.cardCount, 1);

  const explained = await executeAgentOperation(root, "llmnav_explain", { file: "src/rotate.ts" });
  assert.equal(explained.ok, true);
  assert.equal(explained.operation, "explain");
  assert.equal(explained.data.status, "candidate");
  assert.equal(explained.data.navigationCards[0].id, "auth.session.rotate");
});

test("check resolves relations against the session registry snapshot", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-agent-check-session-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const session = await createProjectSession(root);
  const first = session.registrySnapshot();
  const second = session.registrySnapshot();
  assert.notEqual(first, second, "registry snapshots are detached copies");
  assert.deepEqual(first.records, second.records);

  let snapshots = 0;
  const stub = {
    ...session,
    registrySnapshot() {
      snapshots += 1;
      return first;
    },
  };
  const checked = await executeAgentOperation(root, "llmnav_check", { paths: ["src"] }, { session: stub });
  assert.equal(checked.ok, true);
  assert.equal(checked.data.cardCount, 1);
  assert.equal(snapshots, 1, "check reuses the prepared registry instead of rereading it");
});

test("returns bounded audit candidates with deterministic priority ordering", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-agent-audit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createAuditProject(root);

  const audit = await auditProject(root);
  const result = await executeAgentOperation(root, "llmnav_audit", {});
  assert.equal(result.ok, true);
  assert.equal(result.operation, "audit");
  assert.equal(result.data.repositoryId, audit.repositoryId);
  assert.deepEqual(result.data.summary, audit.summary);
  assert.equal(result.data.minimumPriority, "low");
  assert.equal(result.data.matched, audit.candidates.length);
  assert.equal(result.data.truncated, false);
  assert.deepEqual(result.data.candidates.map((item) => item.path), audit.candidates.map((item) => item.path));
  assert.equal(result.data.candidates[0].priority, "high");
  for (const candidate of result.data.candidates) {
    assert.deepEqual(Object.keys(candidate), ["path", "priority", "score", "reasons", "suggestedCoverageRule"]);
  }

  const bounded = await executeAgentOperation(root, "llmnav_audit", { top: 1 });
  assert.equal(bounded.data.candidates.length, 1);
  assert.equal(bounded.data.truncated, audit.candidates.length > 1);

  const high = await executeAgentOperation(root, "llmnav_audit", { priority: "high" });
  assert.equal(high.data.minimumPriority, "high");
  assert.deepEqual(
    high.data.candidates.map((item) => item.path),
    audit.candidates.filter((item) => item.priority === "high").map((item) => item.path),
  );

  const unknownPriority = await executeAgentOperation(root, "llmnav_audit", { priority: "urgent" });
  assert.equal(unknownPriority.ok, false);
  assert.equal(unknownPriority.error.code, "LNVAP002");
  assert.match(unknownPriority.error.message, /must be one of: high, medium, low/u);

  const zeroTop = await executeAgentOperation(root, "llmnav_audit", { top: 0 });
  assert.equal(zeroTop.error.code, "LNVAP002");
});

test("returns stable protocol failures for invalid input and missing IDs", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-agent-errors-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);

  const unknownField = await executeAgentOperation(root, "llmnav_query", { task: "token", root: "elsewhere" });
  assert.equal(unknownField.ok, false);
  assert.equal(unknownField.error.code, "LNVAP002");
  assert.match(unknownField.error.message, /Unknown input field/u);

  const invalidBound = await executeAgentOperation(root, "llmnav_context", { id: "auth.session.rotate", depth: 9 });
  assert.equal(invalidBound.error.code, "LNVAP002");

  const missing = await executeAgentOperation(root, "llmnav_show", { id: "missing.capability" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "LNVAP404");

  for (const options of [{}, { session: await createProjectSession(root) }]) {
    const missingContext = await executeAgentOperation(root, "llmnav_context", { id: "missing.capability" }, options);
    assert.equal(missingContext.ok, false);
    assert.equal(missingContext.error.code, "LNVAP404");
    assert.match(missingContext.error.message, /Unknown or inactive semantic ID/u);
  }

  await writeFile(path.join(root, ".llmnav", "ids.jsonl"), [
    '{"id":"auth.session.rotate","state":"active"}',
    '{"id":"other.capability","state":"active"}',
    '{"id":"old.capability","state":"replaced","by":["auth.session.rotate","other.capability"]}',
    "",
  ].join("\n"));
  for (const options of [{}, { session: await createProjectSession(root) }]) {
    const ambiguousShow = await executeAgentOperation(root, "llmnav_show", { id: "old.capability" }, options);
    const ambiguousContext = await executeAgentOperation(root, "llmnav_context", { id: "old.capability" }, options);
    assert.equal(ambiguousShow.error.code, "LNVAP409");
    assert.equal(ambiguousContext.error.code, "LNVAP409");
  }

  const unknown = await executeAgentOperation(root, "provider_specific_tool", {});
  assert.equal(unknown.error.code, "LNVAP001");
});

test("keeps the documented envelope shape and error code table", async () => {
  assert.deepEqual(AGENT_OPERATION_ERROR_CODES, {
    unknownOperation: "LNVAP001",
    invalidInput: "LNVAP002",
    notFound: "LNVAP404",
    ambiguous: "LNVAP409",
    internal: "LNVAP500",
  });

  const unknown = await executeAgentOperation(".", "nope", {});
  assert.deepEqual(unknown, {
    schemaVersion: 1,
    operation: "unknown",
    ok: false,
    data: null,
    error: { code: "LNVAP001", message: 'Unknown agent operation "nope".' },
  });

  const invalid = await executeAgentOperation(".", "llmnav_query", {});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.operation, "query");
  assert.equal(invalid.data, null);
  assert.deepEqual(invalid.error, { code: "LNVAP002", message: "Missing required input field(s): task." });
});

test("maps handler outcomes and thrown errors onto the operation envelope", async () => {
  const empty = await executeAgentOperation(".", "llmnav_query", { task: "anything" }, { session: { query: () => [] } });
  assert.deepEqual(empty, { schemaVersion: 1, operation: "query", ok: true, data: [], error: null });

  const throwing = { query() { throw new Error("snapshot store unavailable"); } };
  const internal = await executeAgentOperation(".", "llmnav_query", { task: "token" }, { session: throwing });
  assert.equal(internal.ok, false);
  assert.equal(internal.error.code, "LNVAP500");
  assert.equal(internal.error.message, "snapshot store unavailable");
  assert.equal(internal.data, null);
  assert.deepEqual(internal.error.data, { code: null, retryable: false, cause: [] });

  const ambiguousResult = { resolvedFrom: { state: "ambiguous" } };
  const ambiguous = await executeAgentOperation(
    ".",
    "llmnav_show",
    { id: "old.capability" },
    { session: { show: () => ambiguousResult } },
  );
  assert.deepEqual(ambiguous, {
    schemaVersion: 1,
    operation: "show",
    ok: false,
    data: ambiguousResult,
    error: {
      code: "LNVAP409",
      message: "Ambiguous semantic ID old.capability; qualify or replace it with one candidate.",
    },
  });

  const cycleResult = { resolvedFrom: { state: "cycle" } };
  const cycle = await executeAgentOperation(".", "llmnav_show", { id: "loop.capability" }, { session: { show: () => cycleResult } });
  assert.equal(cycle.error.code, "LNVAP500");
  assert.match(cycle.error.message, /Registry cycle prevents resolving semantic ID loop\.capability/u);
  assert.equal(cycle.data, cycleResult);

  const missingResult = { resolvedFrom: { state: "missing" } };
  const missing = await executeAgentOperation(".", "llmnav_show", { id: "missing.capability" }, { session: { show: () => missingResult } });
  assert.equal(missing.error.code, "LNVAP404");
  assert.equal(missing.data, missingResult);
});

async function createAuditProject(root) {
  await writeFile(path.join(root, "package.json"), '{"name":"agent-audit-fixture","main":"src/main.ts"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export function boot(): void {}\n");
  await writeFile(
    path.join(root, "src", "billing.ts"),
    "export function charge(): void {}\nexport function refund(): void {}\n",
  );
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
}

async function createProject(root) {
  await writeFile(path.join(root, "package.json"), '{"name":"agent-protocol-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "rotate.ts"),
    `/* llmnav/1 symbol
id=auth.session.rotate
role=Rotate one refresh-token family and reject replayed tokens.
search=refresh token|token rotation|replay detection
stability=contract
*/
export function rotateSession(): void {}
`,
  );
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
}
