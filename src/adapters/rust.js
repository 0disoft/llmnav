/* llmnav/1 module
id=llmnav.structure.rust-process
role=Isolate Rust syntax analysis so deadlines, cancellation and heap failures cannot block the calling event loop.
owns=Rust worker invocation|Rust analysis failure isolation
excludes=type checking|macro expansion|application execution
search=Rust syntax metadata|Rust analysis deadline|Rust analysis cancellation
invariant=CPU-intensive Rust parsing runs only in a bounded child process and cancellation waits for its exit.
rel=workflow>llmnav.structure.analyze
rel=workflow>llmnav.structure.compiler-process
stability=architecture
*/

import { fileURLToPath } from "node:url";
import { runCompiler } from "./process.js";

// This bounds the worker's V8 old-space heap, not its total RSS.
const WORKER_HEAP_MIB = 256;
const ERROR_TYPES = new Map([["TypeError", TypeError], ["RangeError", RangeError], ["SyntaxError", SyntaxError]]);

export async function analyzeRust(root, files, options = {}) {
  const output = await runCompiler(process.execPath, [
    `--max-old-space-size=${WORKER_HEAP_MIB}`, fileURLToPath(new URL("./rust-worker.js", import.meta.url)),
  ], { ...options, cwd: root, input: JSON.stringify({ root, files, allowErrors: options.allowErrors === true }) });
  const message = JSON.parse(output);
  if (message.error) {
    const Constructor = ERROR_TYPES.get(message.error.name) ?? Error;
    const error = new Constructor(message.error.message);
    if (message.error.code !== undefined) error.code = message.error.code;
    throw error;
  }
  return message.result;
}
