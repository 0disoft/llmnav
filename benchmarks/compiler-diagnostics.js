import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { runCompiler } from "../src/adapters/process.js";

// Run from the repository root; the baseline is read without changing the checkout.
const baselineRef = process.argv[2] ?? "f2e94a5";
const source = execFileSync("git", ["show", `${baselineRef}:src/adapters/process.js`], { encoding: "utf8" })
  .replace('"../abort.js"', JSON.stringify(new URL("../src/abort.js", import.meta.url).href));
const baseline = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const script = `
  const chunk = Buffer.alloc(65536, 97);
  for (let i = 0; i < 1024; i++) {
    if (!process.stderr.write(chunk)) await new Promise(resolve => process.stderr.once('drain', resolve));
  }
  process.exitCode = 3;
`;
const expected = `Compiler analysis exited 3: ${"a".repeat(1024 * 1024)}`;
const results = { baseline: [], current: [] };
for (let round = 0; round < 3; round++) {
  for (const [name, run] of [["baseline", baseline.runCompiler], ["current", runCompiler]]) {
    const cpu = process.cpuUsage(), start = performance.now();
    await assert.rejects(run(process.execPath, ["--input-type=module", "-e", script]), error => {
      assert.equal(error.exitCode, 3);
      assert.equal(error.message, expected);
      return true;
    });
    const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
    results[name].push({ elapsedMs: Number(elapsedMs.toFixed(2)), parentCpuMs: Number(((used.user + used.system) / 1000).toFixed(2)) });
  }
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, baselineRef, stderrBytes: 64 * 1024 * 1024, results }, null, 2));
