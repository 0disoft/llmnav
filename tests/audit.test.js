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
  await mkdir(path.join(root, "tests", "helpers"), { recursive: true });
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
    path.join(root, "src", "util.js"),
    Array.from({ length: 12 }, (_, index) => `export function helper${index}() {}`).join("\n") + "\n",
  );
  for (let index = 0; index < 7; index += 1) {
    await writeFile(
      path.join(root, "src", `consumer-${index}.js`),
      `import { centralContract } from "./central.js";\nimport { helper0 } from "./util.js";\nexport function consumer${index}() { return centralContract() ?? helper0(); }\n`,
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
  assert.equal(byPath.get("src/util.js").priority, "low");
  assert.equal(byPath.get("src/util.js").signals.broadUtility, true);
  assert.equal(byPath.has("src/index.js"), false);
  assert.equal(byPath.has("tests/helpers/shared.js"), false);
  assert.equal(byPath.has("src/types.d.ts"), false);
  assert.equal(byPath.has("src/carded.js"), false);
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

test("audit CLI emits stable JSON and supports fail-on thresholds", async (context) => {
  const root = await createAuditFixture(context);
  const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));
  const { spawnSync } = await import("node:child_process");
  const advisory = spawnSync(process.execPath, [cli, "audit", "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.equal(JSON.parse(advisory.stdout).summary.high >= 2, true);

  const gated = spawnSync(process.execPath, [cli, "audit", "--root", root, "--fail-on", "high", "--json"], { encoding: "utf8" });
  assert.equal(gated.status, 1, gated.stderr);
  assert.equal(JSON.parse(gated.stdout).failOn, "high");

  const invalid = spawnSync(process.execPath, [cli, "audit", "--root", root, "--fail-on", "urgent"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /audit --fail-on must be one of/u);
});
