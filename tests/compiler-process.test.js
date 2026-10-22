import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { runCompiler } from "../src/adapters/process.js";

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
