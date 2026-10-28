import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { collectSourceFiles } from "../src/files.js";
import { formatProject } from "../src/formatter.js";
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

for (const mode of ["incremental", "full", "format-check"]) {
  for (const boundary of ["before-child-enumeration", "after-file-enumeration"]) {
    test(`source directory replacement rejects external reads (mode=${mode}, boundary=${boundary})`, async context => {
      const full = mode === "full";
      const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "llmnav-source-link-race-"));
      context.after(() => fs.rm(fixture, { recursive: true, force: true }));
      const root = path.join(fixture, "project"), outside = path.join(fixture, "external");
      const source = path.join(root, "src"), backup = path.join(fixture, "original");
      await fs.mkdir(source, { recursive: true });
      await fs.mkdir(outside);
      await fs.writeFile(path.join(source, "entry.js"), card("fixture.inside"));
      await fs.writeFile(path.join(outside, "entry.js"), card("fixture.outside"));
      await initializeProject(root, { agents: ["none"] });
      const before = await controlSnapshot(root);
      const original = fs.readdir;
      let swapped = false, externalReads = 0, externalEnumerations = 0;
      const trigger = boundary === "before-child-enumeration" ? root : source;
      const mock = context.mock.method(fs, "readdir", async (directory, options) => {
        if (directory === source && swapped) externalEnumerations++;
        const entries = await original(directory, options);
        if (directory === trigger && !swapped) {
          await fs.rename(source, backup);
          await fs.symlink(outside, source, process.platform === "win32" ? "junction" : "dir");
          swapped = true;
        }
        return entries;
      });
      syncBuiltinESMExports();
      try {
        const operation = mode === "format-check" ? formatProject(root, { check: true }) : generateProject(root, { full, ioConcurrency: 1, io: {
          readFile(file, encoding, options) {
            if (file === path.join(source, "entry.js") && swapped) externalReads++;
            return fs.readFile(file, { encoding, signal: options.signal });
          },
        } }).then(async result => {
          const index = JSON.parse(await fs.readFile(path.join(root, ".llmnav/cache/index.json"), "utf8"));
          context.diagnostic(JSON.stringify({ ok: result.ok, externalReads, externalEnumerations, indexedOutside: index.cards.some(item => item.id === "fixture.outside") }));
          return result;
        });
        await assert.rejects(operation, /traverses symbolic link/u);
        assert.equal(swapped, true);
        assert.equal(externalReads, 0);
        assert.equal(externalEnumerations, 0);
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
        if (swapped) {
          await fs.rm(source, { recursive: true, force: true });
          await fs.rename(backup, source);
        }
      }
      assert.deepEqual(await controlSnapshot(root), before);
      assert.equal((await queryProject(root, "fixture.inside"))[0].id, "fixture.inside");
      assert.equal((await generateProject(root, { full, ioConcurrency: 1 })).ok, true);
    });
  }
}
