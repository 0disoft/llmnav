/* llmnav/1 module
id=llmnav.structure.compiler-process
role=Bound opt-in compiler subprocesses and retain cancellation, failure, and exit ownership.
owns=compiler process deadlines|bounded output|process cancellation|exit cleanup
excludes=dependency installation|project execution
search=compiler subprocess|analysis deadline|compiler process failure
invariant=Analysis executes only explicitly selected compiler tooling and never project application code.
rel=workflow>llmnav.structure.analyze
stability=architecture
*/

import { spawn } from "node:child_process";
import { assertAbortSignal, createAbortError, throwIfAborted } from "../abort.js";

const STDERR_CHARACTER_LIMIT = 1024 * 1024;

// Compiler processes are opt-in. Observe exit before releasing owned temporary files.
export async function runCompiler(command, args, options = {}) {
  assertAbortSignal(options.signal);
  throwIfAborted(options.signal);
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new RangeError("Compiler timeoutMs must be a positive timer-range integer.");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "", bytes = 0, failure = null;
    const stop = error => { failure ??= error; child.kill(); };
    const onAbort = () => stop(createAbortError(options.signal));
    const timer = setTimeout(() => stop(Object.assign(new Error("Compiler analysis timed out."), { code: "LNV102" })), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", error => { failure ??= error; });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") failure ??= error; });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32 * 1024 * 1024) stop(new Error("Compiler analysis exceeded the 32 MiB output limit."));
      else output += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      const remaining = STDERR_CHARACTER_LIMIT - errors.length;
      if (remaining > 0) errors += chunk.slice(0, remaining);
    });
    child.once("close", code => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error(`Compiler analysis exited ${code}: ${errors.trim()}`), { exitCode: code }));
      else resolve(output);
    });
    child.stdin.end(options.input ?? "");
    if (options.signal?.aborted) onAbort();
  });
}
