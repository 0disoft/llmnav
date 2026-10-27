import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { collectSourceFiles } from "../src/files.js";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { queryProject } from "../src/search.js";

const card = id => `/* llmnav/1 module\nid=${id}\nrole=Handle fixture application requests.\nstability=implementation\n*/\nexport const value = 1;\n`;

async function controlSnapshot(root) {
  const directory = path.join(root, ".llmnav");
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(directory, file), await fs.readFile(file)])));
}

for (const full of [false, true]) {
  for (const ioConcurrency of [1, 2]) {
    test(`disappearing descendants preserve published state (full=${full}, concurrency=${ioConcurrency})`, async context => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "llmnav-traversal-race-"));
      context.after(() => fs.rm(root, { recursive: true, force: true }));
      const disappearing = path.join(root, "gone");
      await fs.mkdir(disappearing);
      await fs.mkdir(path.join(root, "keep"));
      await fs.writeFile(path.join(root, "top.js"), card("fixture.top"));
      await fs.writeFile(path.join(root, "keep", "present.js"), card("fixture.keep"));
      await initializeProject(root, { agents: ["none"] });
      const before = await controlSnapshot(root);
      const original = fs.readdir;
      let removed = false;
      const mock = context.mock.method(fs, "readdir", async (directory, options) => {
        if (directory === disappearing && !removed) {
          removed = true;
          await fs.rm(directory, { recursive: true, force: true });
        }
        return original(directory, options);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(generateProject(root, { full, ioConcurrency }), { code: "ENOENT" });
        assert.equal(removed, true);
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
      }
      assert.deepEqual(await controlSnapshot(root), before);
      assert.equal((await queryProject(root, "fixture.keep"))[0].id, "fixture.keep");
      const recovered = await generateProject(root, { full, ioConcurrency });
      assert.equal(recovered.ok, true);
      assert.equal((await queryProject(root, "fixture.keep"))[0].id, "fixture.keep");
    });
  }
}

test("source roots absent before traversal remain optional", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llmnav-optional-root-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "top.js"), "export const value = 1;\n");
  const { config } = await loadConfig(root);
  const files = await collectSourceFiles(root, config, ["not-created", "top.js"]);
  assert.deepEqual(files, [path.join(root, "top.js")]);
});
