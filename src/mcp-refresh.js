/* llmnav/1 module
id=llmnav.agent.freshness
role=Prepare current source-derived indexes before opt-in MCP navigation requests.
owns=source change stamps|on-request incremental generation|refresh failure reporting
excludes=filesystem watchers|source annotation|request cancellation ownership
search=source edit refresh|automatic MCP generation|index freshness
invariant=Only a successful uncancelled generation advances the prepared source stamp.
rel=workflow>llmnav.index.generate
stability=architecture
*/

import { lstat } from "node:fs/promises";
import path from "node:path";
import { abortable, throwIfAborted } from "./abort.js";
import { loadConfig } from "./config.js";
import { collectSourceFiles } from "./files.js";
import { generateProject } from "./generator.js";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { assertNoSymlinkTraversal, compareText, relativePosix, sha256 } from "./util.js";

// Each cache owns one preparer. The session cache supplies single-flight and a
// shared deadline; individual subscribers never own this generation's signal.
export function createSourcePreparation(root, dependencies = {}) {
  const readStamp = dependencies.sourceStamp ?? sourceStamp;
  const generate = dependencies.generateProject ?? generateProject;
  let preparedStamp = null;
  return async (options = {}) => {
    throwIfAborted(options.signal);
    const nextStamp = await readStamp(root, options);
    throwIfAborted(options.signal);
    if (nextStamp === preparedStamp) return;
    try {
      const result = await generate(root, { signal: options.signal });
      throwIfAborted(options.signal);
      if (!result.ok) {
        const details = (result.diagnostics ?? []).filter(item => item.level === "error" || item.severity === "error")
          .map(item => `${item.code}: ${item.message}`).join("; ");
        throw new Error(details || "Source validation or index generation failed.");
      }
      // Keep the pre-generation stamp: an edit made during generation must be
      // detected by the next request instead of being acknowledged unread.
      preparedStamp = nextStamp;
    } catch (cause) {
      throwIfAborted(options.signal);
      throw Object.assign(new Error("MCP source refresh failed. Fix the source or generation failure and retry.", { cause }), {
        code: "LLMNAV_REFRESH_FAILED",
      });
    }
  };
}

export async function sourceStamp(root, options = {}) {
  await assertNoSymlinkTraversal(root, path.join(root, ".llmnav/config.json"), ".llmnav/config.json");
  const { config } = await loadConfig(root, options);
  const files = await collectSourceFiles(root, config, [], options);
  const inputs = new Set([".llmnav/config.json", ...config.graph.indexFiles]);
  inputs.add("go.mod");
  for (const file of files) {
    const relative = relativePosix(root, file);
    inputs.add(relative);
    if (!relative.endsWith(".go")) continue;
    let directory = path.posix.dirname(relative);
    while (directory !== ".") {
      const metadata = `${directory}/go.mod`;
      if (inputs.has(metadata)) break;
      inputs.add(metadata);
      directory = path.posix.dirname(directory);
    }
  }
  const parts = await mapWithConcurrency([...inputs].sort(compareText),
    options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY, async relative => {
      throwIfAborted(options.signal);
      const absolute = path.join(root, relative);
      await assertNoSymlinkTraversal(root, absolute, relative);
      try {
        const info = await abortable(lstat(absolute, { bigint: true }), options.signal);
        if (!info.isFile()) throw new Error(`${relative} is not a regular source input.`);
        return `${relative}:${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.dev}:${info.ino}`;
      } catch (error) {
        throwIfAborted(options.signal);
        if (error?.code === "ENOENT") return `${relative}:missing`;
        throw error;
      }
    }, { signal: options.signal });
  return sha256(JSON.stringify(parts));
}
