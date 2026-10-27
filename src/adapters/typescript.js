/* llmnav/1 module
id=llmnav.structure.typescript
role=Resolve an installed TypeScript Compiler API and run source analysis in an isolated process.
owns=compiler resolution|TypeScript worker invocation
excludes=dependency installation|project execution
search=TypeScript compiler adapter|isolated TypeScript analysis
invariant=Analysis executes only explicitly selected compiler tooling and never project application code.
rel=workflow>llmnav.structure.analyze
stability=architecture
*/

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCompiler } from "./process.js";

export async function analyzeTypeScript(root, files, options = {}) {
  let compiler;
  if (options.typescriptPath) compiler = path.resolve(options.typescriptPath);
  else {
    const require = createRequire(path.join(root, "package.json"));
    try { compiler = require.resolve("typescript"); }
    catch (cause) {
      try { compiler = createRequire(import.meta.url).resolve("typescript"); }
      catch { throw new Error("TypeScript Compiler API is unavailable. Supply --typescript <path-to-typescript.js> (supported major versions: 5 and 6).", { cause }); }
    }
  }
  const output = await runCompiler(process.execPath, [fileURLToPath(new URL("./typescript-worker.js", import.meta.url))], {
    ...options, cwd: root, input: JSON.stringify({ root, files, compiler, project: options.project, language: options.language, allowErrors: options.allowErrors === true, metadata: options.metadata === true }),
  });
  return JSON.parse(output);
}
