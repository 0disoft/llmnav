import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../src/initializer.js";
import { scanProject } from "../src/project.js";
import { validateProject } from "../src/validator.js";

async function fixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-validator-"));
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "feature.ts"), source);
  await initializeProject(root, { agents: ["agents"] });
  return root;
}

test("accepts a valid contract card", async (context) => {
  const root = await fixture(`/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate one refresh-token family and reject replayed tokens.\nsearch=refresh token|token rotation|replay detection\ninvariant=One token family has at most one live refresh token.\neffect=db.write(session_tokens)\nrisk=concurrency\nstability=contract\n*/\nexport function rotateSession() {}\n`);
  context.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = validateProject(await scanProject(root));
  assert.deepEqual(diagnostics.filter((item) => item.severity === "error"), []);
});

test("rejects volatile metadata and hand-maintained call edges", async (context) => {
  const root = await fixture(`/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate a session.\nsearch=refresh token|token rotation\npath=src/auth/session.ts\nrel=calls>auth.session.repository\nstability=contract\n*/\nexport function rotateSession() {}\n`);
  context.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = validateProject(await scanProject(root));
  assert.ok(diagnostics.some((item) => item.code === "LNV003"));
  assert.ok(diagnostics.some((item) => item.code === "LNV004"));
});

test("rejects source and cache paths that escape the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-paths-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await initializeProject(root, { agents: ["agents"] });
  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8"));
  config.generation.cacheDirectory = "../outside";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(() => scanProject(root), /generation\.cacheDirectory must not contain parent-directory traversal/u);
});

test("reports malformed configuration without a type crash", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-bad-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await writeFile(
    path.join(root, ".llmnav", "config.json"),
    JSON.stringify({ sourceRoots: { bad: true }, repositoryId: "bad\nvalue", generation: null }),
  );
  await assert.rejects(
    () => scanProject(root),
    /repositoryId must match[\s\S]*sourceRoots must be an array[\s\S]*generation must be an object/u,
  );
});

test("rejects empty fields and empty list items", async (context) => {
  const root = await fixture(`/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate one refresh-token family.\nsearch=refresh token||token rotation\neffect=\nstability=contract\n*/\nexport function rotateSession() {}\n`);
  context.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = validateProject(await scanProject(root));
  assert.ok(diagnostics.some((item) => item.message === "Field search contains an empty list item."));
  assert.ok(diagnostics.some((item) => item.message === "Field effect must not be empty."));
});

test("enforces effect argument arity", async (context) => {
  const root = await fixture(`/* llmnav/1 symbol\nid=storage.snapshot.write\nrole=Persist one stable snapshot and record filesystem access.\nsearch=snapshot storage|filesystem write\neffect=db.write|fs.write(snapshot)\nstability=contract\n*/\nexport function writeSnapshot() {}\n`);
  context.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = validateProject(await scanProject(root));
  assert.ok(diagnostics.some((item) => item.message.startsWith("Effect db.write requires one stable target argument")));
  assert.ok(diagnostics.some((item) => item.message === "Effect fs.write does not accept an argument."));
});

test("rejects duplicate semantic values outside search", async (context) => {
  const root = await fixture(`/* llmnav/1 symbol\nid=cache.entry.refresh\nrole=Refresh one cached entry while preserving its freshness contract.\nsearch=cache refresh|stale entry\ninvariant=One refresh owns the cache lease.\ninvariant=One refresh owns the cache lease.\neffect=cache.write(entries)|cache.write(entries)\nrel=policy>cache.entry.policy\nrel=policy>cache.entry.policy\nstability=contract\n*/\nexport function refreshEntry() {}\n`);
  context.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = validateProject(await scanProject(root));
  assert.ok(diagnostics.some((item) => item.message === "invariant contains duplicate values."));
  assert.ok(diagnostics.some((item) => item.message === "effect contains duplicate values."));
  assert.ok(diagnostics.some((item) => item.message === "rel contains duplicate values."));
});

test("rejects malformed custom vocabulary identifiers", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-bad-vocabulary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await initializeProject(root, { agents: ["agents"] });
  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8"));
  config.lint.additionalEffects = ["queue.publish(name)"];
  config.lint.additionalRisks = ["Data Loss"];
  config.lint.additionalRelations = ["calls>"];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(
    () => scanProject(root),
    /additionalEffects\[0\][\s\S]*additionalRisks\[0\][\s\S]*additionalRelations\[0\]/u,
  );
});

test("rejects unknown configuration and coverage properties", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-unknown-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await initializeProject(root, { agents: ["none"] });
  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8"));
  config.lint.maxRelatons = 5;
  config.coverageRules = [{ match: ["src/**"], requiredFeilds: ["risk"] }];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(
    () => scanProject(root),
    /coverageRules\[0\] contains unknown property "requiredFeilds"[\s\S]*lint contains unknown property "maxRelatons"/u,
  );
});

test("rejects broad, ambiguous, and unexplained audit dispositions", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-bad-audit-dispositions-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await initializeProject(root, { agents: ["none"] });
  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8"));
  config.audit.ignored = [];
  config.audit.dispositions = [
    { path: "src/**/*.js", reason: "This broad glob would hide future files without review." },
    { path: "src\\adapter.js", reason: "too short" },
    { path: "src/adapter.js", reason: "This exact adapter owns no durable navigation boundary." },
    { path: "SRC/ADAPTER.JS", reason: "This spelling duplicates the preceding path across platforms." },
  ];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(
    () => scanProject(root),
    /audit contains unknown property "ignored"[\s\S]*without glob syntax[\s\S]*must use forward slashes[\s\S]*at least 12 characters[\s\S]*duplicates an earlier disposition/u,
  );
});

test("rejects cache directories that overlap LLMNav control state", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-cache-control-overlap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await initializeProject(root, { agents: ["none"] });
  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8"));
  config.generation.cacheDirectory = ".llmnav/.transactions/cache";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(() => scanProject(root), /must not overlap LLMNav control state/u);
});

test("rejects malformed registry records and redirect cycles", async (context) => {
  const root = await fixture(`/* llmnav/1 symbol\nid=core.feature.active\nrole=Expose one active feature contract.\nsearch=active feature|feature contract\nstability=contract\n*/\nexport function activeFeature() {}\n`);
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, ".llmnav", "ids.jsonl"),
    [
      '{"id":"core.feature.active","state":"active"}',
      '{"id":"core.alias.one","state":"redirect","to":"core.alias.two"}',
      '{"id":"core.alias.two","state":"redirect","to":"core.alias.one"}',
      '{"id":"core.legacy.old","state":"retired","to":"core.feature.active"}',
      '{"id":"core.invalid.state","state":"paused"}',
      "",
    ].join("\n"),
  );
  const diagnostics = validateProject(await scanProject(root));
  assert.ok(diagnostics.some((item) => item.message.includes("must not declare to or by")));
  assert.ok(diagnostics.some((item) => item.message.includes("invalid state")));
  assert.ok(diagnostics.some((item) => item.message.includes("participates in a redirect or replacement cycle")));
});

test("rejects semantic relations that resolve to retired IDs", async (context) => {
  const root = await fixture(`/* llmnav/1 symbol\nid=core.feature.use-policy\nrole=Apply one active policy before completing the feature.\nsearch=feature policy|apply policy\nrel=policy>core.policy.retired\nstability=contract\n*/\nexport function usePolicy() {}\n`);
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, ".llmnav", "ids.jsonl"),
    '{"id":"core.feature.use-policy","state":"active"}\n{"id":"core.policy.retired","state":"retired"}\n',
  );
  const diagnostics = validateProject(await scanProject(root));
  assert.ok(diagnostics.some((item) => item.code === "LNV008" && item.message.includes("resolves to retired")));
});
