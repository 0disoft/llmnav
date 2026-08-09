import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeAgentOperation, getAgentToolDefinitions } from "../src/agent-protocol.js";
import { initializeProject } from "../src/initializer.js";

test("publishes stable provider-neutral tool definitions", () => {
  const definitions = getAgentToolDefinitions();
  assert.deepEqual(definitions.map((item) => item.name), [
    "llmnav_query",
    "llmnav_show",
    "llmnav_context",
    "llmnav_check",
  ]);
  assert.ok(definitions.every((item) => item.schemaVersion === 1));
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

  const unknown = await executeAgentOperation(root, "provider_specific_tool", {});
  assert.equal(unknown.error.code, "LNVAP001");
});

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
