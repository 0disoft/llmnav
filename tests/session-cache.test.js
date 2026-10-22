import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createSessionCache } from "../src/mcp.js";

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
