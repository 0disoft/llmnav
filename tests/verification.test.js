import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { captureVerificationSnapshot, recordVerification, getVerification } from "../src/verification.js";
import { executeAgentOperation } from "../src/agent-protocol.js";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-verification-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.ts"), "one\n");
  await writeFile(path.join(root, "test.log"), "PASS\n");
  return root;
}
test("verification separates caller-reported outcomes from source, context and evidence applicability", async context => {
  const root = await fixture(context);
  const snapshot = await captureVerificationSnapshot(root, ["source.ts"], { completeInputs: true, context: { toolchain: "test-1" } });
  const { id } = await recordVerification(root, { snapshot, command: ["node", "--test"], outcome: "passed", evidence: ["test.log"] });
  const unknown = await getVerification(root, id);
  assert.equal(unknown.outcome, "passed");
  assert.equal(unknown.sourceMatch, "matches");
  assert.equal(unknown.applicability, "unknown");
  const options = { context: { toolchain: "test-1" }, details: true };
  const applicable = await getVerification(root, id, options);
  assert.equal(applicable.applicability, "matches");
  assert.equal(applicable.receipt.provenance, "caller-reported");
  assert.equal((await getVerification(root, id, { context: { toolchain: "test-2" } })).applicability, "stale");
  await writeFile(path.join(root, "source.ts"), "two\n");
  assert.equal((await getVerification(root, id, options)).applicability, "stale");
  await writeFile(path.join(root, "source.ts"), "one\n");
  await rm(path.join(root, "test.log"));
  assert.equal((await getVerification(root, id, options)).evidenceMatch, "stale");
});
test("incomplete scope and inputs changed during validation never become current proof", async context => {
  const root = await fixture(context);
  const snapshot = await captureVerificationSnapshot(root, ["source.ts"]);
  const input = { snapshot, command: ["tool", "arg".repeat(400)], outcome: "passed", evidence: ["test.log"] };
  const first = await recordVerification(root, input);
  assert.equal((await getVerification(root, first.id)).applicability, "unknown");
  const bounded = await getVerification(root, first.id, { details: true, metadataBudget: 512 });
  assert.equal(bounded.detailsOmitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 512);
  await writeFile(path.join(root, "source.ts"), "changed during test\n");
  const changed = await recordVerification(root, input);
  await writeFile(path.join(root, "source.ts"), "one\n");
  assert.equal((await getVerification(root, changed.id)).applicability, "stale");
  const wire = await executeAgentOperation(root, "llmnav_verification", { id: first.id });
  assert.equal(wire.data.outcome, "passed");
  assert.equal(wire.data.receipt, undefined);
});
test("parallel immutable receipts retain all results, detect tampering and reject unsafe inputs", async context => {
  const root = await fixture(context);
  const snapshot = await captureVerificationSnapshot(root, ["source.ts"]);
  const records = await Promise.all(["passed", "failed", "unknown"].map(outcome => recordVerification(root, { snapshot, command: ["test"], outcome })));
  assert.equal(new Set(records.map(item => item.id)).size, 3);
  for (const record of records) assert.equal((await getVerification(root, record.id)).outcome, record.receipt.outcome);
  const record = records[0];
  const file = path.join(root, record.path);
  await writeFile(file, `${await readFile(file, "utf8")} `);
  await assert.rejects(getVerification(root, record.id), /integrity/u);
  await assert.rejects(captureVerificationSnapshot(root, ["../outside"]), /relative/u);
  await assert.rejects(captureVerificationSnapshot(root, ["missing"]), /exist/u);
  assert.equal((await getVerification(root, "0".repeat(64))).status, "unknown");
  await assert.rejects(getVerification(root, "../../outside"), /ID/u);
});
