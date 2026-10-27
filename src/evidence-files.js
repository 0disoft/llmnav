/* llmnav/1 module
id=llmnav.evidence.files
role=Hash explicitly selected repository files for local provenance without retaining their contents.
owns=evidence path containment|bounded byte fingerprints|file handle lifetime
excludes=semantic card validation|secret content storage
search=local evidence file hashing|repository fingerprints
invariant=Evidence paths remain inside the repository and open handles close after errors or cancellation.
stability=architecture
*/

import path from "node:path";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { throwIfAborted } from "./abort.js";
import { assertNoSymlinkTraversal } from "./util.js";

export async function evidencePath(root, file) {
  if (typeof file !== "string" || !file || /[\x00-\x1f]/u.test(file) || file.includes("\\") || path.isAbsolute(file) || /^[A-Za-z]:/u.test(file) || file.split("/").includes("..")) throw new TypeError("Evidence requires a safe repository-relative file path.");
  const absolute = path.resolve(root, file);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new TypeError("Evidence path must stay inside the repository.");
  await assertNoSymlinkTraversal(root, absolute, file);
  return { absolute, relative: relative.split(path.sep).join("/") };
}

export async function fingerprintFile(root, file, options = {}) {
  throwIfAborted(options.signal);
  const { absolute } = await evidencePath(root, file);
  let handle;
  try { handle = await open(absolute, "r"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new TypeError("Evidence inputs must be regular files.");
    const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      throwIfAborted(options.signal);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 64 * 1024 * 1024) throw new RangeError("Evidence file exceeds 64 MiB.");
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`Evidence input changed while hashing: ${file}`);
    throwIfAborted(options.signal);
    return hash.digest("hex");
  } finally { await handle.close(); }
}
