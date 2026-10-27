/* llmnav/1 module
id=llmnav.structure.go
role=Prepare offline Go dependency exports and invoke the standard-library type analysis producer.
owns=offline Go metadata|Go analyzer build|temporary executable lifetime
excludes=dependency installation|project execution
search=Go compiler adapter|offline Go type analysis
invariant=Analysis executes only explicitly selected compiler tooling and never project application code.
rel=workflow>llmnav.structure.analyze
stability=architecture
*/

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCompiler } from "./process.js";

export async function analyzeGo(root, files, options = {}) {
  const env = { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local", GOWORK: "off", CGO_ENABLED: "0", GOFLAGS: "" };
  const command = options.goCommand ?? "go";
  const context = { ...options, cwd: root, env };
  // go list selects the active platform/build-tag files and supplies dependency
  // export data. It never runs tests, project binaries, or go generate.
  const listing = await runCompiler(command, ["list", ...(options.allowErrors ? ["-e"] : []), "-mod=readonly", "-deps", "-export", "-json", "./..."], context);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "llmnav-go-analysis-"));
  try {
    const executable = path.join(temporary, process.platform === "win32" ? "analyzer.exe" : "analyzer");
    await runCompiler(command, ["build", "-p=2", "-o", executable, fileURLToPath(new URL("./go-analyzer.go", import.meta.url))], context);
    const output = await runCompiler(executable, [], {
      ...context, input: JSON.stringify({ root, files, listing, allowErrors: options.allowErrors === true, metadata: options.metadata === true }),
    });
    return JSON.parse(output);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
