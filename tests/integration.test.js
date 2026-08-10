import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installAgentInstructions } from "../src/agents.js";
import { evaluateProject } from "../src/evaluation.js";
import { findProjectRoot } from "../src/files.js";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { scanProject } from "../src/project.js";
import { buildContext, queryProject } from "../src/search.js";

test("initializes, generates, verifies, and searches a project", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-integration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"demo-project"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "reserve.ts"),
    `/* llmnav/1 symbol\nid=billing.credit.reserve\nrole=Reserve credits before an external generation job starts.\nsearch=credit hold|reserve credits|generation billing\ninvariant=Captured credits never exceed the active reservation.\neffect=db.write(credit_reservations)\nrisk=concurrency\nstability=contract\n*/\nexport async function reserveCredits() {}\n`,
  );

  const initialized = await initializeProject(root, { agents: ["all"], packageScripts: true });
  assert.equal(initialized.ok, true);
  await access(path.join(root, "AGENTS.md"));
  await access(path.join(root, "CLAUDE.md"));
  await access(path.join(root, ".github", "copilot-instructions.md"));
  await access(path.join(root, ".cursor", "rules", "llmnav.mdc"));
  for (const instructionPath of [
    "AGENTS.md",
    "CLAUDE.md",
    ".github/copilot-instructions.md",
    ".cursor/rules/llmnav.mdc",
    ".llmnav/AGENT_INSTRUCTIONS.md",
  ]) {
    const instructions = await readFile(path.join(root, instructionPath), "utf8");
    assert.match(instructions, /npm exec -- llmnav query/u);
    assert.match(instructions, /npm exec -- llmnav audit/u);
    assert.match(instructions, /npm exec -- llmnav check/u);
  }
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["llmnav:check"], "llmnav check");
  assert.equal(packageJson.scripts["llmnav:audit"], "llmnav audit --fail-on high");

  const verified = await generateProject(root, { check: true });
  assert.equal(verified.ok, true, verified.changedFiles.join(", "));

  const [result] = await queryProject(root, "reserve generation credits", { top: 3 });
  assert.equal(result.id, "billing.credit.reserve");

  const generated = JSON.parse(await readFile(path.join(root, ".llmnav", "cache", "index.json"), "utf8"));
  assert.equal(generated.repositoryId, "demo-project");
  assert.equal(generated.cards.length, 1);
});

test("refuses a symlinked LLMNav control directory", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-symlink-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "llmnav-symlink-outside-"));
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(root, "package.json"), '{"name":"symlink-fixture"}\n');
  const { symlink } = await import("node:fs/promises");
  await symlink(outside, path.join(root, ".llmnav"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => initializeProject(root, { agents: ["agents"] }),
    /traverses symbolic link/u,
  );
});

test("semantic catalogs survive body edits and file moves", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-cache-stability-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"cache-fixture"}\n');
  await mkdir(path.join(root, "src"));
  const originalPath = path.join(root, "src", "reserve.ts");
  const movedPath = path.join(root, "src", "reserve-moved.ts");
  const card = `/* llmnav/1 symbol\nid=billing.credit.reserve\nrole=Reserve credits before an external generation job starts.\nsearch=credit hold|reserve credits|generation billing\ninvariant=One idempotency key creates at most one reservation.\neffect=db.write(credit_reservations)\nrisk=concurrency\nstability=contract\n*/\n`;
  await writeFile(originalPath, `${card}export function reserveCredits() { return 1; }\n`);
  await initializeProject(root, { agents: ["agents"] });
  const catalogPath = path.join(root, ".llmnav", "cache", "modules", "billing.credit.txt");
  const firstCatalog = await readFile(catalogPath, "utf8");
  const firstIndex = await readFile(path.join(root, ".llmnav", "cache", "index.json"), "utf8");

  const { rename } = await import("node:fs/promises");
  await rename(originalPath, movedPath);
  await writeFile(movedPath, `${card}export function reserveCreditsRenamed() { return 2; }\n`);
  await generateProject(root, { check: false });

  const secondCatalog = await readFile(catalogPath, "utf8");
  const secondIndex = await readFile(path.join(root, ".llmnav", "cache", "index.json"), "utf8");
  assert.equal(secondCatalog, firstCatalog);
  assert.notEqual(secondIndex, firstIndex);
  assert.doesNotMatch(secondCatalog, /reserve-moved|reserveCreditsRenamed|loc |sig /u);
});

test("default discovery excludes package-manager caches", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-package-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"package-cache-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".bun-cache", "dependency"), { recursive: true });
  await mkdir(path.join(root, ".pnpm-store", "dependency"), { recursive: true });
  await writeFile(path.join(root, "src", "owned.ts"), "export const owned = true;\n");
  await writeFile(path.join(root, ".bun-cache", "dependency", "foreign.ts"), "export const foreign = true;\n");
  await writeFile(path.join(root, ".pnpm-store", "dependency", "foreign.ts"), "export const foreign = true;\n");
  await initializeProject(root, { agents: ["none"] });

  const project = await scanProject(root);
  assert.deepEqual(project.fileRecords.map((record) => record.relativePath), ["src/owned.ts"]);
});

test("force initialization preserves semantic state and evaluation data", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-force-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"force-fixture"}\n');
  await initializeProject(root, { agents: ["agents"] });

  const state = {
    ids: '{"id":"old.capability","state":"retired"}\n',
    order: 'old.capability\n',
    lexicon: '{"version":1,"aliases":{"old name":"old.capability"}}\n',
    queries: '{"query":"old task","expected":["old.capability"]}\n',
  };
  await writeFile(path.join(root, ".llmnav", "ids.jsonl"), state.ids);
  await writeFile(path.join(root, ".llmnav", "order.lock"), state.order);
  await writeFile(path.join(root, ".llmnav", "lexicon.json"), state.lexicon);
  await writeFile(path.join(root, ".llmnav", "eval", "queries.jsonl"), state.queries);

  await initializeProject(root, { agents: ["agents"], force: true });
  assert.equal(await readFile(path.join(root, ".llmnav", "ids.jsonl"), "utf8"), state.ids);
  assert.equal(await readFile(path.join(root, ".llmnav", "order.lock"), "utf8"), state.order);
  assert.equal(await readFile(path.join(root, ".llmnav", "lexicon.json"), "utf8"), state.lexicon);
  assert.equal(await readFile(path.join(root, ".llmnav", "eval", "queries.jsonl"), "utf8"), state.queries);
});

test("finds an ancestor LLMNav root across a nested package boundary", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-monorepo-root-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"));
  const nested = path.join(root, "packages", "app", "src");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(root, "packages", "app", "package.json"), '{"name":"nested-app"}\n');
  assert.equal(await findProjectRoot(nested), root);
});

test("rejects evaluation files outside the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-eval-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "llmnav-eval-outside-"));
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(root, "package.json"), '{"name":"eval-fixture"}\n');
  await initializeProject(root, { agents: ["none"] });
  const outsideFile = path.join(outside, "queries.jsonl");
  await writeFile(outsideFile, '{"query":"x","expected":["x.y"]}\n');
  await assert.rejects(() => evaluateProject(root, { file: outsideFile }), /evaluation query file escapes the repository root/u);
});

test("resolves redirected IDs when building context", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-context-redirect-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"context-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "rotate.ts"),
    `/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate one refresh-token family.\nsearch=refresh token|token rotation\nstability=contract\n*/\nexport function rotateSession() {}\n`,
  );
  await initializeProject(root, { agents: ["none"] });
  await writeFile(
    path.join(root, ".llmnav", "ids.jsonl"),
    '{"id":"auth.session.rotate","state":"active"}\n{"id":"auth.session.renew","state":"redirect","to":"auth.session.rotate"}\n',
  );
  const result = await buildContext(root, "auth.session.renew", { depth: -5, budget: 1 });
  assert.equal(result.id, "auth.session.rotate");
  assert.equal(result.depth, 0);
  assert.equal(result.budget, 128);
  assert.deepEqual(result.included, ["auth.session.rotate"]);
});

test("rejects unknown agent adapters and incomplete managed blocks", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-agent-errors-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"agent-fixture"}\n');
  await assert.rejects(() => initializeProject(root, { agents: ["copliot"] }), /Unknown agent adapter/u);

  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "# Instructions\n\n<!-- llmnav:start -->\n");
  await assert.rejects(() => installAgentInstructions(root, ["agents"]), /incomplete LLMNav managed block/u);
});
