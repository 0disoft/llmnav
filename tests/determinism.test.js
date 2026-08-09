import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateProject } from "../src/generator.js";
import { compareText, relativePosix, sha256 } from "../src/util.js";
import { createSyntheticProject } from "./helpers/synthetic.js";

test("generated cache bytes are independent of source creation and traversal order", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "llmnav-determinism-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const forwardRoot = path.join(parent, "forward");
  const reverseRoot = path.join(parent, "reverse");
  await createSyntheticProject(forwardRoot, { fileCount: 120, cardsPerFile: 5 });
  await createSyntheticProject(reverseRoot, { fileCount: 120, cardsPerFile: 5, fileOrder: "reverse" });

  const forward = await generateProject(forwardRoot);
  const reverse = await generateProject(reverseRoot);
  assert.equal(forward.ok, true);
  assert.equal(reverse.ok, true);
  const forwardTree = await hashTree(forwardRoot);
  const reverseTree = await hashTree(reverseRoot);
  assert.deepEqual(reverseTree, forwardTree);
});

async function hashTree(root) {
  const cacheRoot = path.join(root, ".llmnav", "cache");
  const records = [];
  await visit(cacheRoot);
  records.sort((left, right) => compareText(left.path, right.path));
  return records;

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const content = await readFile(absolute);
        records.push({ path: relativePosix(cacheRoot, absolute), bytes: content.byteLength, sha256: sha256(content) });
      }
    }
  }
}
