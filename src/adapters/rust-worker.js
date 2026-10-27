/* llmnav/1 module
id=llmnav.structure.rust-worker
role=Run conservative Rust syntax extraction inside the owned analysis subprocess.
owns=Rust worker input decoding|analysis result transport|analysis error transport
excludes=type checking|application execution|process lifecycle ownership
search=Rust isolated worker|Rust syntax extraction process
invariant=The worker parses source as data and its parent owns deadlines, cancellation and process exit.
rel=workflow>llmnav.structure.rust
rel=workflow>llmnav.structure.rust-process
stability=architecture
*/

import { analyzeRustSyntax } from "./rust-syntax.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const { root, files, allowErrors } = JSON.parse(input);
  const result = await analyzeRustSyntax(root, files, { allowErrors });
  console.log(JSON.stringify({ result }));
} catch (error) {
  console.log(JSON.stringify({ error: { name: error.name, message: error.message, ...(error.code === undefined ? {} : { code: error.code }) } }));
}
