import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject, writeAnalysis } from "../src/analysis.js";

test("Go rejects consumed source changes before final rereads and preserves published output", {
  skip: spawnSync("go", ["version"], { windowsHide: true }).status !== 0, timeout: 120000,
}, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-go-snapshot-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".llmnav"));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "go-snapshot" }));
  await writeFile(path.join(root, "go.mod"), "module test.local/snapshot\n\ngo 1.22\n");
  const file = path.join(root, "main.go"), output = ".llmnav/imports/code.json";
  const source = 'package fixture\nfunc Stable() string { return "ok" }\n';
  await writeFile(file, source);
  await writeAnalysis(root, output, await analyzeProject(root, { language: "go", metadata: true }));
  const published = await readFile(path.join(root, output), "utf8");
  for (const [allowErrors, transient] of [[false, "package fixture\nfunc Phantom() int { return 7 }\n"], [true, "package fixture\nfunc Phantom( {\n"]]) {
    let reads = 0;
    const io = { readFile: async (current, encoding, options) => {
      if (current === file) {
        reads++;
        if (reads === 1) {
          const original = await readFile(current, { encoding, ...options });
          await writeFile(file, transient);
          return original;
        }
        // Old code accepted the compiled B after this deterministic undo to A.
        await writeFile(file, source);
      }
      return readFile(current, { encoding, ...options });
    } };
    try {
      await assert.rejects(async () => {
        const result = await analyzeProject(root, { language: "go", metadata: true, allowErrors, io });
        await writeAnalysis(root, output, result);
      }, /Source changed during analysis: main\.go/u);
      assert.equal(reads, 1, "Reject consumed-version mismatch before the final source reread");
    } finally { await writeFile(file, source); }
    assert.equal(await readFile(path.join(root, output), "utf8"), published);
  }
});
