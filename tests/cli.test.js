import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { initializeProject } from "../src/initializer.js";

test("rejects unknown command options", async () => {
  await assert.rejects(() => runCli(["query", "refresh token", "--tp", "5"]), /Unknown option --tp/u);
});

test("rejects missing option values", async () => {
  await assert.rejects(() => runCli(["query", "refresh token", "--top"]), /Option --top requires a value/u);
});

test("rejects values attached to boolean flags", async () => {
  await assert.rejects(() => runCli(["generate", "--check=true"]), /Flag --check does not accept a value/u);
});

test("rejects unknown migration options", async () => {
  await assert.rejects(() => runCli(["migrate", "--force"]), /Unknown option --force for command migrate/u);
});


test("CLI process uses exit status 2 for usage errors", () => {
  const result = spawnSync(process.execPath, ["bin/llmnav.js", "query", "task", "--tp", "5"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option --tp/u);
  assert.doesNotMatch(result.stderr, /at runCli/u);
});

test("rejects invalid integer and diagnostic format values", async () => {
  await assert.rejects(() => runCli(["query", "task", "--top", "many"]), /requires an integer/u);
  await assert.rejects(() => runCli(["check", "--format", "yaml"]), /Unknown diagnostic format/u);
});

test("prints provider-neutral tool schemas outside a repository", () => {
  const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "tools", "--json"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.tools.map((item) => item.name), [
    "llmnav_verification",
    "llmnav_history",
    "llmnav_query",
    "llmnav_show",
    "llmnav_context",
    "llmnav_check",
    "llmnav_explain",
    "llmnav_audit",
    "llmnav_discover",
  ]);
  assert.ok(output.tools.every(item => item.schemaVersion === 8));
});

test("generate --full bypasses incremental accelerators", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-cli-full-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"full-check"}\n');
  await writeFile(
    path.join(root, "source.js"),
    "/* llmnav/1 symbol\nid=full.check.source\nrole=Prove full verification reads canonical source.\nsearch=full verification|source truth\nstability=contract\n*/\nexport function verifySource() {}\n",
  );
  await initializeProject(root, { agents: ["none"] });
  const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "generate", "--root", root, "--full", "--check", "--json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).incremental.enabled, false);
});

test("analyze --json publishes a compiler graph and precise discovery returns usable IDs", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-cli-analysis-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.mts"), "export function target() { return 1; }\nexport function caller() { return target(); }\n");
  await initializeProject(root, { agents: ["none"] });
  const configPath = path.join(root, ".llmnav/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.graph = { indexFiles: [".llmnav/imports/code.json"] };
  await writeFile(configPath, JSON.stringify(config));
  const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));
  const run = args => {
    const result = spawnSync(process.execPath, [cli, ...args, "--root", root, "--json"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const analyzed = run(["analyze", "--language", "typescript", "--output", ".llmnav/imports/code.json"]);
  assert.equal(analyzed.graph.schemaVersion, 2);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, ".llmnav/imports/code.json"), "utf8")), analyzed.graph);
  assert.equal(run(["generate"]).ok, true);
  const target = run(["discover", "target", "--precise"]).results[0];
  assert.equal(target.source, "compiler");
  assert.equal(run(["show", target.id]).node.definitions[0].symbol, "target");
  const detailed = run(["analyze", "--language", "typescript", "--metadata", "--output", ".llmnav/imports/code.json"]);
  assert.equal(detailed.graph.schemaVersion, 3);
  assert.equal(run(["generate"]).ok, true);
  const show = run(["show", target.id, "--metadata", "--metadata-budget", "2000"]);
  assert.equal(show.metadata.items[0].metadata.typeOrigin, "inferred");
  assert.ok(Buffer.byteLength(JSON.stringify(show.metadata)) <= 2000);
  assert.equal(run(["show", target.id]).metadata, undefined);
});
