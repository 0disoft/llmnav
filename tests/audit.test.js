import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditHasFindings, auditProject } from "../src/audit.js";
import { initializeProject } from "../src/initializer.js";

async function createAuditFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-audit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "cli"), { recursive: true });
  await mkdir(path.join(root, "packages", "nested", "src"), { recursive: true });
  await mkdir(path.join(root, "src-tauri", "src"), { recursive: true });
  await mkdir(path.join(root, "tests", "helpers"), { recursive: true });
  await mkdir(path.join(root, "cmd", "gatewayd"), { recursive: true });
  await mkdir(path.join(root, "internal", "auth", "controlaccess"), { recursive: true });
  await mkdir(path.join(root, "internal", "runtime"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "audit-fixture",
      type: "module",
      exports: { ".": "./src/index.js" },
      bin: { fixture: "./src/cli/command.js" },
    }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "src", "index.js"), 'export { publicApi } from "./public-api.js";\n');
  await writeFile(path.join(root, "src", "public-api.js"), "export function publicApi() {}\n");
  await writeFile(path.join(root, "src", "cli", "command.js"), "export async function runCommand() {}\n");
  await writeFile(path.join(root, "src", "central.js"), "export function centralContract() {}\n");
  await writeFile(
    path.join(root, "src", "queue-artifacts.ts"),
    [
      "export const WORK_ORDER_SCHEMA = { schemaVersion: 'workduck.queue-work-order/v1' } as const;",
      ...Array.from({ length: 11 }, (_, index) => `export type QueueContract${index} = { value: string };`),
    ].join("\n") + "\n",
  );
  await writeFile(
    path.join(root, "src", "queue-artifact-files.ts"),
    "export function createWorkOrderFileName(id: string) { return `${id}.workduck-work-order.json`; }\n",
  );
  await writeFile(
    path.join(root, "src", "cli-environment.ts"),
    "const invoke = getTauriInvoke();\nexport async function applyCliEnvironment() { return invoke('apply_cli_environment'); }\n",
  );
  await writeFile(
    path.join(root, "src", "agent-api-snapshot.ts"),
    "const invoke = getTauriInvoke();\nexport async function getAgentApiSnapshot() { return invoke<unknown>('get_agent_api_snapshot'); }\n",
  );
  await writeFile(path.join(root, "src", "persona-prompt.ts"), "export function formatPersonaPromptBlock() { return 'persona'; }\n");
  await writeFile(path.join(root, "src", "secret-vault-error-messages.ts"), "export function secretVaultErrorMessage() { return 'unavailable'; }\n");
  await writeFile(
    path.join(root, "src", "util.js"),
    Array.from({ length: 12 }, (_, index) => `export function helper${index}() {}`).join("\n") + "\n",
  );
  for (let index = 0; index < 7; index += 1) {
    await writeFile(
      path.join(root, "src", `consumer-${index}.js`),
      `import { centralContract } from "./central.js";\nimport { helper0 } from "./util.js";\nimport { WORK_ORDER_SCHEMA } from "./queue-artifacts.ts";\nexport function consumer${index}() { return centralContract() ?? helper0() ?? WORK_ORDER_SCHEMA; }\n`,
    );
  }
  await writeFile(
    path.join(root, "src", "carded.js"),
    `/* llmnav/1 module
id=audit.fixture.carded
role=Represent one already-covered architectural boundary in the audit fixture.
owns=covered fixture boundary
search=covered fixture|existing annotation
stability=architecture
*/
export function carded() {}
`,
  );
  await writeFile(path.join(root, "tests", "helpers", "shared.js"), "export function sharedFixture() {}\n");
  await writeFile(path.join(root, "src", "types.d.ts"), "export interface PublicShape {}\n");
  await writeFile(
    path.join(root, "packages", "nested", "package.json"),
    `${JSON.stringify({ name: "nested-package", exports: { ".": "./src/index.js" } }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "packages", "nested", "src", "index.js"), "export function nestedEntry() {}\n");
  await writeFile(
    path.join(root, "src-tauri", "src", "lib.rs"),
    "mod process_tree;\n#[tauri::command]\nfn open_window() {}\nfn register() { tauri::generate_handler![open_window]; }\n",
  );
  await writeFile(
    path.join(root, "src-tauri", "src", "process_tree.rs"),
    "#[cfg(windows)]\npub(crate) fn shutdown_all_process_trees() {}\nimpl Drop for ProcessTree { fn drop(&mut self) {} }\nstruct ProcessTree;\n",
  );
  await writeFile(path.join(root, "go.mod"), "module example.com/audit-fixture\n\ngo 1.24\n");
  await writeFile(
    path.join(root, "cmd", "gatewayd", "main.go"),
    'package main\n\nimport _ "example.com/audit-fixture/internal/auth/controlaccess"\n\nfunc main() {}\n',
  );
  await writeFile(
    path.join(root, "internal", "auth", "controlaccess", "authenticator.go"),
    "package controlaccess\n\ntype Authenticator struct{}\n",
  );
  await writeFile(
    path.join(root, "internal", "auth", "controlaccess", "oidc.go"),
    `package controlaccess

${Array.from({ length: 12 }, (_, index) => `type OIDCContract${index} struct{}`).join("\n")}
`,
  );
  await writeFile(
    path.join(root, "internal", "auth", "controlaccess", "oidc_test.go"),
    "package controlaccess\n\nfunc TestOIDCContract() {}\n",
  );
  for (let index = 0; index < 4; index += 1) {
    const directory = path.join(root, "internal", `consumer${index}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "consumer.go"),
      `package consumer${index}\n\nimport _ "example.com/audit-fixture/internal/auth/controlaccess"\n`,
    );
  }
  await writeFile(
    path.join(root, "internal", "runtime", "run.go"),
    `package runtime

/* llmnav/1 module
id=audit.fixture.go-runtime
role=Represent one covered Go package boundary in the audit fixture.
owns=covered Go package boundary
search=covered Go package|Go module annotation
stability=architecture
*/
func Run() {}
`,
  );
  await writeFile(
    path.join(root, "internal", "runtime", "journal.go"),
    "package runtime\n\nfunc OpenJournal() {}\n",
  );
  await initializeProject(root, { agents: ["none"] });
  return root;
}

test("audits missing semantic boundaries without modifying source", async (context) => {
  const root = await createAuditFixture(context);
  const trackedPaths = [
    "src/index.js",
    "src/public-api.js",
    "src/cli/command.js",
    "src/central.js",
    "src/util.js",
    "src/carded.js",
  ];
  const before = new Map(await Promise.all(trackedPaths.map(async (file) => [file, await readFile(path.join(root, file), "utf8")])));

  const first = await auditProject(root);
  const second = await auditProject(root);
  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.repositoryId, "audit-fixture");

  const byPath = new Map(first.candidates.map((candidate) => [candidate.path, candidate]));
  assert.equal(byPath.get("src/public-api.js").priority, "high");
  assert.equal(byPath.get("src/public-api.js").signals.publicApi, true);
  assert.equal(byPath.get("src/cli/command.js").priority, "high");
  assert.deepEqual(byPath.get("src/cli/command.js").signals.boundaries, ["command"]);
  assert.equal(byPath.get("src/central.js").priority, "medium");
  assert.equal(byPath.get("src/central.js").signals.importedBy, 7);
  assert.equal(byPath.get("src/queue-artifacts.ts").priority, "high");
  assert.equal(byPath.get("src/queue-artifacts.ts").signals.broadUtility, false);
  assert.deepEqual(byPath.get("src/queue-artifacts.ts").signals.boundaries, ["schema"]);
  assert.equal(byPath.get("src/queue-artifact-files.ts").priority, "medium");
  assert.deepEqual(byPath.get("src/queue-artifact-files.ts").signals.boundaries, ["artifact"]);
  assert.equal(byPath.get("src/cli-environment.ts").priority, "medium");
  assert.deepEqual(byPath.get("src/cli-environment.ts").signals.boundaries, ["command"]);
  assert.equal(byPath.get("src/agent-api-snapshot.ts").priority, "medium");
  assert.deepEqual(byPath.get("src/agent-api-snapshot.ts").signals.boundaries, ["command"]);
  assert.equal(byPath.get("src/persona-prompt.ts").priority, "low");
  assert.equal(byPath.get("src/secret-vault-error-messages.ts").priority, "low");
  assert.equal(byPath.get("src/util.js").priority, "low");
  assert.equal(byPath.get("src/util.js").signals.broadUtility, true);
  assert.equal(byPath.has("src/index.js"), false);
  assert.equal(byPath.has("tests/helpers/shared.js"), false);
  assert.equal(byPath.has("src/types.d.ts"), false);
  assert.equal(byPath.has("src/carded.js"), false);
  assert.equal(byPath.get("packages/nested/src/index.js").signals.packageEntrypoint, true);
  assert.equal(byPath.get("src-tauri/src/lib.rs").signals.boundaries.includes("command"), true);
  assert.equal(byPath.get("src-tauri/src/process_tree.rs").signals.importedBy, 1);
  assert.equal(byPath.get("src-tauri/src/process_tree.rs").signals.boundaries.includes("runtime"), true);
  assert.equal(byPath.get("cmd/gatewayd/main.go").priority, "high");
  assert.deepEqual(byPath.get("cmd/gatewayd/main.go").signals.boundaries, ["command"]);
  assert.equal(byPath.get("internal/auth/controlaccess/oidc.go").priority, "medium");
  assert.equal(byPath.get("internal/auth/controlaccess/oidc.go").signals.importedBy, 5);
  assert.equal(byPath.get("internal/auth/controlaccess/oidc.go").signals.broadUtility, false);
  assert.equal([...byPath.keys()].some((file) => file.startsWith("internal/runtime/")), false);
  assert.equal([...byPath.keys()].some((file) => file.endsWith("_test.go")), false);
  assert.deepEqual(byPath.get("src/public-api.js").suggestedCoverageRule, {
    name: "public-api module boundary",
    match: ["src/public-api.js"],
    scope: "module",
    requiredFields: ["owns", "search"],
  });
  assert.equal(byPath.get("src/util.js").suggestedCoverageRule, null);
  assert.equal(auditHasFindings(first, "high"), true);
  assert.equal(auditHasFindings({ ...first, candidates: [byPath.get("src/util.js")] }, "medium"), false);
  assert.equal(auditHasFindings(first), false);
  assert.throws(() => auditHasFindings(first, "urgent"), /Unknown audit priority/u);

  for (const [file, source] of before) assert.equal(await readFile(path.join(root, file), "utf8"), source);
});

test("suppresses exact reviewed candidates and reports stale dispositions", async (context) => {
  const root = await createAuditFixture(context);
  const baseline = await auditProject(root);
  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.audit.dispositions = [
    { path: "src/index.js", reason: "The file is only a re-export barrel with no durable responsibility." },
    { path: "missing/module.js", reason: "The reviewed file was removed and this record should be cleaned up." },
    { path: "src/central.js", reason: "This helper coordinates local fixture data but owns no durable contract." },
    { path: "src/carded.js", reason: "The file now has a reviewed module card and no longer needs suppression." },
  ];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const result = await auditProject(root);
  assert.equal(result.candidates.some((candidate) => candidate.path === "src/central.js"), false);
  assert.equal(result.summary.candidates, baseline.summary.candidates - 1);
  assert.equal(result.summary.suppressedCandidates, 1);
  assert.equal(result.summary.staleDispositions, 3);
  assert.deepEqual(result.dispositions, [
    {
      path: "missing/module.js",
      reason: "The reviewed file was removed and this record should be cleaned up.",
      status: "stale",
      staleReason: "file-not-scanned",
    },
    {
      path: "src/carded.js",
      reason: "The file now has a reviewed module card and no longer needs suppression.",
      status: "stale",
      staleReason: "already-carded",
    },
    {
      path: "src/central.js",
      reason: "This helper coordinates local fixture data but owns no durable contract.",
      status: "suppressed",
      priority: "medium",
      score: 40,
    },
    {
      path: "src/index.js",
      reason: "The file is only a re-export barrel with no durable responsibility.",
      status: "stale",
      staleReason: "not-a-candidate",
    },
  ]);
});

test("audit CLI emits stable JSON and supports fail-on thresholds", async (context) => {
  const root = await createAuditFixture(context);
  const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));
  const { spawnSync } = await import("node:child_process");
  const advisory = spawnSync(process.execPath, [cli, "audit", "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.equal(JSON.parse(advisory.stdout).summary.high >= 2, true);
  assert.equal(Array.isArray(JSON.parse(advisory.stdout).dispositions), true);

  const gated = spawnSync(process.execPath, [cli, "audit", "--root", root, "--fail-on", "high", "--json"], { encoding: "utf8" });
  assert.equal(gated.status, 1, gated.stderr);
  assert.equal(JSON.parse(gated.stdout).failOn, "high");

  const invalid = spawnSync(process.execPath, [cli, "audit", "--root", root, "--fail-on", "urgent"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /audit --fail-on must be one of/u);

  const summary = spawnSync(process.execPath, [cli, "audit", "--root", root, "--json", "--summary"], { encoding: "utf8" });
  assert.equal(summary.status, 0, summary.stderr);
  assert.deepEqual(Object.keys(JSON.parse(summary.stdout)), ["schemaVersion", "repositoryId", "summary", "failOn"]);

  const outputFile = path.join(root, ".llmnav", "audit.json");
  const output = spawnSync(process.execPath, [cli, "audit", "--root", root, "--json", "--output", ".llmnav/audit.json"], { encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
  const envelope = JSON.parse(output.stdout);
  assert.equal(envelope.output, ".llmnav/audit.json");
  assert.equal(Array.isArray(JSON.parse(await readFile(outputFile, "utf8")).candidates), true);

  const escaped = spawnSync(process.execPath, [cli, "audit", "--root", root, "--output", "../audit.json"], { encoding: "utf8" });
  assert.equal(escaped.status, 2);
  assert.match(escaped.stderr, /audit output file escapes the repository root/u);
});
