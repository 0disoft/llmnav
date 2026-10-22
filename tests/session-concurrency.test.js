import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLlmnavHost } from "../examples/provider-neutral-host.mjs";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { createProjectSession } from "../src/search.js";

function source(term) {
  return `/* llmnav/1 module\nid=demo.cache\nrole=Own ${term} processing.\nstability=architecture\n*/\nexport const value = 1;\n`;
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-refresh-order-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"refresh-order"}');
  await mkdir(path.join(root, "src"));
  const file = path.join(root, "src/demo.js");
  await writeFile(file, source("oldtag"));
  assert.equal((await initializeProject(root, { agents: ["none"] })).ok, true);
  return { root, file };
}

function pauseSnapshotReturn(context) {
  const paused = Promise.withResolvers(), resume = Promise.withResolvers();
  const originalRm = fs.rm;
  let armed = true;
  const mock = context.mock.method(fs, "rm", async (target, ...args) => {
    if (armed && String(target).includes("generation.lock.tmp-release-")) {
      armed = false;
      paused.resolve();
      await resume.promise;
    }
    return originalRm(target, ...args);
  });
  syncBuiltinESMExports();
  return { paused: paused.promise, resume: resume.resolve, restore() { mock.mock.restore(); syncBuiltinESMExports(); } };
}

for (const kind of ["session", "host"]) {
  test(`${kind} keeps the newest successful refresh when an older load finishes last`, { timeout: 15000 }, async (context) => {
    const { root, file } = await fixture(context);
    const subject = kind === "session" ? await createProjectSession(root, { withPromptBundle: true }) : await createLlmnavHost(root);
    const query = async term => kind === "session" ? subject.query(term) : (await subject.execute({ name: "llmnav_query", input: { task: term } })).data;
    const gate = pauseSnapshotReturn(context);
    const older = subject.refresh();
    try {
      await gate.paused;
      await writeFile(file, source("newtag"));
      assert.equal((await generateProject(root)).ok, true);
      await subject.refresh();
      const newestHash = subject.generationHash;
      const newestPrompt = structuredClone(kind === "session" ? subject.promptBundle : subject.basePromptPartitions);
      assert.equal((await query("newtag"))[0].id, "demo.cache");
      gate.resume();
      await older;
      assert.equal((await query("newtag"))[0].id, "demo.cache");
      assert.deepEqual(await query("oldtag"), []);
      assert.equal(subject.generationHash, newestHash);
      assert.deepEqual(kind === "session" ? subject.promptBundle : subject.basePromptPartitions, newestPrompt);
    } finally {
      gate.resume(); await older; gate.restore();
    }
  });
}

test("a failed newer refresh does not discard an older successful snapshot", { timeout: 15000 }, async (context) => {
  const { root, file } = await fixture(context);
  const session = await createProjectSession(root);
  await writeFile(file, source("newtag"));
  assert.equal((await generateProject(root)).ok, true);
  const gate = pauseSnapshotReturn(context);
  const older = session.refresh();
  try {
    await gate.paused;
    const failure = new Error("newer load failed");
    await assert.rejects(session.refresh({ io: { readFile: async () => { throw failure; } } }), error => error === failure);
    const controller = new AbortController();
    controller.abort(failure);
    await assert.rejects(session.refresh({ signal: controller.signal }), error => error === failure);
    gate.resume(); await older;
    assert.equal(session.query("newtag")[0].id, "demo.cache");
    assert.deepEqual(session.query("oldtag"), []);
  } finally {
    gate.resume(); await older; gate.restore();
  }
});
