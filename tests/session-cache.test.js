import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceStamp, createSourcePreparation } from "../src/mcp-refresh.js";
import { createSessionCache } from "../src/mcp.js";
import { sha256 } from "../src/util.js";

function deadline() {
  let fire;
  return {
    scheduler: { setTimeout(callback) { fire = callback; return callback; }, clearTimeout() {} },
    expire() { fire(); },
  };
}

test("a timed-out shared load is replaceable and cannot publish a late snapshot", async () => {
  const clock = deadline();
  const started = Promise.withResolvers(), delayed = Promise.withResolvers();
  const fresh = { refresh: async () => {} };
  let creates = 0, firstSignal;
  const cache = createSessionCache("unused", {
    sessionStamp: async () => "same", scheduler: clock.scheduler,
    createSession: async (root, { signal }) => {
      creates++;
      if (creates !== 1) return fresh;
      firstSignal = signal; started.resolve(); return delayed.promise;
    },
  });
  const first = cache.current();
  assert.equal(cache.current(), first);
  await started.promise;
  clock.expire();
  await assert.rejects(first, error => error.code === "LNV102" && firstSignal.reason === error);
  assert.equal(await cache.current(), fresh);
  delayed.resolve({ refresh: async () => { throw new Error("obsolete"); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await cache.current(), fresh);
  assert.equal(creates, 2);
});

test("a timed-out refresh detaches the old mutable session", async () => {
  const clock = deadline(), started = Promise.withResolvers(), delayed = Promise.withResolvers();
  let stamp = "old", creates = 0;
  const old = { refresh: async () => { started.resolve(); await delayed.promise; old.value = "late"; } };
  const fresh = { value: "fresh", refresh: async () => {} };
  const cache = createSessionCache("unused", {
    sessionStamp: async () => stamp, scheduler: clock.scheduler,
    createSession: async () => ++creates === 1 ? old : fresh,
  });
  assert.equal(await cache.current(), old);
  stamp = "new";
  const refresh = cache.current();
  await started.promise;
  clock.expire();
  await assert.rejects(refresh, { code: "LNV102" });
  assert.equal(await cache.current(), fresh);
  delayed.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await cache.current(), fresh);
});

test("one subscriber's cancellation leaves the shared load available to others", async () => {
  const delayed = Promise.withResolvers(), started = Promise.withResolvers();
  let sharedSignal;
  const cache = createSessionCache("unused", {
    sessionStamp: async () => "same",
    createSession: async (root, { signal }) => { sharedSignal = signal; started.resolve(); return delayed.promise; },
  });
  const controller = new AbortController(), reason = new Error("request cancelled");
  const subscriber = cache.current({ signal: controller.signal });
  const other = cache.current();
  await started.promise;
  controller.abort(reason);
  await assert.rejects(subscriber, error => error === reason);
  assert.equal(sharedSignal.aborted, false);
  const session = {};
  delayed.resolve(session);
  assert.equal(await other, session);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("server shutdown cancels shared loading with the original reason and removes listeners", async () => {
  const controller = new AbortController(), reason = new Error("server closed");
  const started = Promise.withResolvers();
  let sharedSignal;
  const cache = createSessionCache("unused", {
    signal: controller.signal, sessionStamp: async () => "same",
    createSession: (root, { signal }) => { sharedSignal = signal; started.resolve(); return new Promise(() => {}); },
  });
  const pending = cache.current();
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(sharedSignal.reason, reason);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("shared preparation runs once, preserves cancellation ownership, and retries failures on the next request", async () => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  let generates = 0, stamp = "first", fail = false;
  const cause = new Error("disk full");
  const prepare = createSourcePreparation("unused", {
    sourceStamp: async () => stamp,
    generateProject: async (root, { signal }) => {
      generates++;
      started.resolve();
      await gate.promise;
      assert.equal(signal.aborted, false);
      if (fail) throw cause;
      return { ok: true };
    },
  });
  const cache = createSessionCache("unused", {
    prepare, sessionStamp: async () => stamp, createSession: async () => ({ refresh: async () => {} }),
  });
  const controller = new AbortController();
  const first = cache.current({ signal: controller.signal });
  const second = cache.current();
  await started.promise;
  assert.equal(cache.status().phase, "preparing");
  controller.abort(new Error("stop subscriber"));
  await assert.rejects(first, /stop subscriber/u);
  gate.resolve();
  await second;
  assert.equal(cache.status().phase, "ready");
  await cache.current();
  assert.equal(generates, 1);
  stamp = "changed";
  fail = true;
  await assert.rejects(cache.current(), error => error.cause === cause && error.code === "LLMNAV_REFRESH_FAILED");
  assert.equal(cache.status().phase, "error");
  fail = false;
  await cache.current();
  assert.equal(generates, 3);
});

test("edits during preparation and late abandoned completions are not acknowledged", async () => {
  let stamp = "first", generates = 0;
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  const controller = new AbortController();
  const prepare = createSourcePreparation("unused", {
    sourceStamp: async () => stamp,
    generateProject: async () => { generates++; started.resolve(); await gate.promise; return { ok: true }; },
  });
  const late = prepare({ signal: controller.signal });
  await started.promise;
  controller.abort(new Error("abandoned"));
  gate.resolve();
  await assert.rejects(late, /abandoned/u);
  await prepare();
  assert.equal(generates, 2);
  const changing = createSourcePreparation("unused", {
    sourceStamp: async () => stamp,
    generateProject: async () => { generates++; stamp = "second"; return { ok: true }; },
  });
  await changing();
  await changing();
  await changing();
  assert.equal(generates, 4);
});

test("source stamps include Go and configured graph metadata and reject metadata junctions", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-source-stamp-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "llmnav-source-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".llmnav"));
  await mkdir(path.join(root, "metadata"));
  await writeFile(path.join(root, "src/main.go"), "package main\n");
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "fixture", graph: { indexFiles: ["metadata/graph.json"] } }));
  const initial = await sourceStamp(root);
  await writeFile(path.join(root, "src/go.mod"), "module example.test/nested\n");
  const go = await sourceStamp(root);
  assert.notEqual(go, initial);
  await writeFile(path.join(root, "metadata/graph.json"), "{}\n");
  const graph = await sourceStamp(root);
  assert.notEqual(graph, go);
  assert.equal(await sourceStamp(root), graph);
  await rm(path.join(root, "metadata"), { recursive: true });
  await symlink(outside, path.join(root, "metadata"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(sourceStamp(root), /symbolic link/u);
});

test("compiler dependency stamping limits graph reads and rejects dependency junctions", { timeout: 5000 }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-compiler-stamp-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "llmnav-compiler-stamp-external-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(outside, { recursive: true, force: true }));
  for (const directory of [".llmnav", "src", "inputs", "settings"]) await mkdir(path.join(root, directory));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "fixture", sourceRoots: ["src"], graph: { indexFiles: ["inputs/z.json", "inputs/a.json"] } }));
  await writeFile(path.join(root, "src/main.ts"), "export const value = true;\n");
  await writeFile(path.join(root, "settings/base.json"), '{"target":"ES2022"}');
  const graph = JSON.stringify({ schemaVersion: 2, repositoryId: "fixture", sourceHashes: { "settings/base.json": sha256('{"target":"ES2022"}') }, definitions: [], references: [] });
  for (const name of ["a", "z"]) await writeFile(path.join(root, `inputs/${name}.json`), graph);
  const both = Promise.withResolvers();
  let active = 0, peak = 0, graphReads = 0;
  const readPaths = [];
  const initial = await sourceStamp(root, { ioConcurrency: 2, io: { readFile: async (file, encoding) => {
    readPaths.push(file);
    if (path.dirname(file) !== path.join(root, "inputs")) return readFile(file, encoding);
    graphReads++; active++; peak = Math.max(peak, active);
    if (active === 2) both.resolve();
    await both.promise;
    try { return await readFile(file, encoding); } finally { active--; }
  } } });
  assert.equal(graphReads, 2); assert.equal(peak, 2); assert.equal(active, 0);
  assert.equal(readPaths.includes(path.join(root, "settings/base.json")), false);
  assert.equal(readPaths.includes(path.join(root, "src/main.ts")), false);
  assert.equal(await sourceStamp(root), initial);
  await writeFile(path.join(root, "settings/base.json"), '{"target":"ES2023"}');
  assert.notEqual(await sourceStamp(root), initial);
  await rm(path.join(root, "settings"), { recursive: true });
  await writeFile(path.join(outside, "base.json"), "{}\n");
  await symlink(outside, path.join(root, "settings"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(sourceStamp(root), /symbolic link/u);
});

test("preparation reports dependency-probe failures with their original cause", async () => {
  const cause = Object.assign(new Error("compiler graph is unreadable"), { code: "EACCES" });
  let generations = 0;
  const prepare = createSourcePreparation("unused", {
    sourceStamp: async () => { throw cause; },
    generateProject: async () => { generations++; return { ok: true }; },
  });
  await assert.rejects(prepare(), error => error.code === "LLMNAV_REFRESH_FAILED" && error.cause === cause);
  assert.equal(generations, 0);
});
