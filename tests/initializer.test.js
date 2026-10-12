import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));

async function fixture(context, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-bootstrap-"));
  context.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("llmnav-bootstrap-"));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name })}\n`);
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args, "--root", root, "--json"], { encoding: "utf8", timeout: 10000 });
}

for (const name of ["123-calculator", "@team/123-calculator", `project-${"a".repeat(100)}`]) {
  test(`first CLI initialization accepts package name ${name}`, async (context) => {
    const root = await fixture(context, name);
    const initialized = run(root, "init", "--agents", "none");
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(JSON.parse(initialized.stdout).ok, true);
    const configPath = path.join(root, ".llmnav", "config.json");
    const configText = await readFile(configPath, "utf8");
    const config = JSON.parse(configText);
    assert.match(config.repositoryId, /^[a-z][a-z0-9-]{0,63}$/u);
    const checked = run(root, "check");
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).ok, true);
    const repeated = run(root, "init", "--agents", "none");
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(await readFile(configPath, "utf8"), configText);
    const forced = run(root, "init", "--agents", "none", "--force");
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).repositoryId, config.repositoryId);
  });
}

test("long names with the same prefix keep distinct deterministic IDs", async (context) => {
  const first = await fixture(context, `${"a".repeat(100)}-one`);
  const second = await fixture(context, `${"a".repeat(100)}-two`);
  for (const root of [first, second]) assert.equal(run(root, "init", "--agents", "none").status, 0);
  const firstId = JSON.parse(await readFile(path.join(first, ".llmnav", "config.json"), "utf8")).repositoryId;
  const secondId = JSON.parse(await readFile(path.join(second, ".llmnav", "config.json"), "utf8")).repositoryId;
  assert.notEqual(firstId, secondId);
});

test("valid short names retain their existing inferred IDs", async (context) => {
  const root = await fixture(context, "@Team/Useful_App");
  assert.equal(run(root, "init", "--agents", "none").status, 0);
  assert.equal(JSON.parse(await readFile(path.join(root, ".llmnav", "config.json"), "utf8")).repositoryId, "useful-app");
});
