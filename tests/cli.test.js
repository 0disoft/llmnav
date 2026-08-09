import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";

test("rejects unknown command options", async () => {
  await assert.rejects(() => runCli(["query", "refresh token", "--tp", "5"]), /Unknown option --tp/u);
});

test("rejects missing option values", async () => {
  await assert.rejects(() => runCli(["query", "refresh token", "--top"]), /Option --top requires a value/u);
});

test("rejects values attached to boolean flags", async () => {
  await assert.rejects(() => runCli(["generate", "--check=true"]), /Flag --check does not accept a value/u);
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
    "llmnav_query",
    "llmnav_show",
    "llmnav_context",
    "llmnav_check",
  ]);
});
