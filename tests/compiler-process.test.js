import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCompiler } from "../src/adapters/process.js";

test("supported signals without listener removal cannot crash subprocess consumers", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-signal-like-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  const script = `
    import assert from 'node:assert/strict';
    import { runCompiler } from ${JSON.stringify(new URL("../src/adapters/process.js", import.meta.url).href)};
    import { getFileHistory } from ${JSON.stringify(new URL("../src/index.js", import.meta.url).href)};
    const compatibleSignal = () => ({ aborted: false, addEventListener(_type, listener) { this.listener = listener; } });
    assert.equal(await runCompiler(process.execPath, ['-e', 'process.stdout.write("한글")'], { signal: compatibleSignal() }), '한글');
    await assert.rejects(runCompiler(process.execPath, ['-e', 'process.stderr.write("bad input");process.exit(3)'], { signal: compatibleSignal() }), { exitCode: 3, message: 'Compiler analysis exited 3: bad input' });
    await assert.rejects(runCompiler('llmnav-missing-compiler-executable', [], { signal: compatibleSignal() }), { code: 'ENOENT' });
    await assert.rejects(runCompiler(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: compatibleSignal(), timeoutMs: 20 }), { code: 'LNV102' });
    const signal = compatibleSignal(), reason = new Error('host cancelled analysis');
    const pending = runCompiler(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal });
    signal.aborted = true; signal.reason = reason; signal.listener();
    await assert.rejects(pending, error => error === reason);
    const history = await getFileHistory(process.argv[1], 'source.ts', { signal: compatibleSignal() });
    assert.equal(history.reason, 'not-a-git-repository');
    process.stdout.write('completed');
  `;
  // Isolate the regression: an exception in the close event terminates its host process.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], {
    encoding: "utf8", windowsHide: true, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, "completed");
});

test("compiler diagnostics retain the same UTF-16 prefix at and beyond the cap", async () => {
  const limit = 1024 * 1024;
  for (const length of [limit - 1, limit, limit + 1]) {
    const script = `process.stderr.write('a'.repeat(${length}),()=>{process.exitCode=3;});`;
    await assert.rejects(runCompiler(process.execPath, ["-e", script]), error => {
      assert.equal(error.exitCode, 3);
      assert.equal(error.message, `Compiler analysis exited 3: ${"a".repeat(Math.min(length, limit))}`);
      return true;
    });
  }
  const script = `const text='한🙂'.repeat(400000);process.stderr.write(text,()=>{process.stderr.write('discarded tail',()=>{process.exitCode=3;});});`;
  await assert.rejects(runCompiler(process.execPath, ["-e", script]), error => {
    assert.equal(error.exitCode, 3);
    assert.equal(error.message, `Compiler analysis exited 3: ${"한🙂".repeat(400000).slice(0, limit)}`);
    return true;
  });
});

test("compiler subprocess boundaries preserve Unicode, abort causes, deadlines and listener cleanup", async () => {
  const output = await runCompiler(process.execPath, ["-e", "const x=Buffer.from('한글'); for (const byte of x) process.stdout.write(Buffer.from([byte]));"]);
  assert.equal(output, "한글");
  await assert.rejects(runCompiler(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 20 }), { code: "LNV102" });
  const controller = new AbortController(), reason = new Error("stop compiler");
  const pending = runCompiler(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(runCompiler("llmnav-missing-compiler-executable", []), { code: "ENOENT" });
  await assert.rejects(runCompiler(process.execPath, ["-e", "process.stderr.write('bad input');process.exit(3)"]), /bad input/u);
});
