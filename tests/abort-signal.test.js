import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ABORT_ERROR_NAME, createAbortError, throwIfAborted } from "../src/abort.js";
import { auditProject } from "../src/audit.js";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { queryProject } from "../src/search.js";

function abortedController() {
  const controller = new AbortController();
  controller.abort();
  return controller;
}

function isAbortError(error) {
  return error instanceof Error && error.name === ABORT_ERROR_NAME;
}

test("abort helpers preserve caller reasons and tolerate missing signals", () => {
  assert.equal(throwIfAborted(), undefined);
  assert.equal(throwIfAborted(new AbortController().signal), undefined);

  const controller = new AbortController();
  controller.abort();
  assert.throws(() => throwIfAborted(controller.signal), (error) => isAbortError(error));

  const custom = new Error("cancelled by caller");
  const withReason = new AbortController();
  withReason.abort(custom);
  assert.throws(() => throwIfAborted(withReason.signal), (error) => error === custom);

  const withText = new AbortController();
  withText.abort("shutdown");
  assert.throws(
    () => throwIfAborted(withText.signal),
    (error) => isAbortError(error) && error.message === "shutdown",
  );
  const fallback = createAbortError(undefined);
  assert.equal(fallback.name, ABORT_ERROR_NAME);
  assert.equal(fallback.message, "The operation was aborted.");
});

test("a signal rejected before generation leaves the cache and lock untouched", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-abort-generate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const before = await readFile(indexPath, "utf8");

  await assert.rejects(() => generateProject(root, { signal: abortedController().signal }), isAbortError);

  assert.equal(await readFile(indexPath, "utf8"), before);
  await assert.rejects(() => readFile(path.join(root, ".llmnav", "generation.lock"), "utf8"), /ENOENT/u);
  const [result] = await queryProject(root, "reserve credits");
  assert.equal(result.id, "billing.credit.reserve");
});

test("an abort during cache commit rolls back like any other failure", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-abort-commit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const before = await readFile(indexPath, "utf8");
  const sourcePath = path.join(root, "src", "reserve.ts");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("generation job", "cancellable generation job"));
  const controller = new AbortController();

  await assert.rejects(
    () => generateProject(root, {
      signal: controller.signal,
      onTransactionPhase: (phase) => {
        if (phase === "after-cache-moved") controller.abort("caller cancelled");
      },
    }),
    isAbortError,
  );

  assert.equal(await readFile(indexPath, "utf8"), before);
  await assert.rejects(() => readFile(path.join(root, ".llmnav", "generation-transaction.json"), "utf8"), /ENOENT/u);
  const [result] = await queryProject(root, "reserve credits");
  assert.equal(result.id, "billing.credit.reserve");
});

test("queries and audits honour an already-aborted signal", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-abort-read-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  const signal = abortedController().signal;

  await assert.rejects(() => queryProject(root, "reserve credits", { signal }), isAbortError);
  await assert.rejects(() => auditProject(root, { signal }), isAbortError);
});

test("invalid signals are rejected instead of silently ignored", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-abort-shape-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root);
  await assert.rejects(() => generateProject(root, { signal: {} }), /AbortSignal/u);
});

async function createProject(root) {
  await writeFile(path.join(root, "package.json"), '{"name":"abort-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "reserve.ts"),
    `/* llmnav/1 symbol
id=billing.credit.reserve
role=Reserve credits before a generation job starts.
search=credit hold|reserve credits
stability=contract
*/
export function reserveCredits() { return 1; }
`,
  );
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
}
