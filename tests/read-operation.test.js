import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { runRead } from "../src/index.js";
import { readText } from "../src/util.js";

function timers() {
  const pending = new Map();
  const added = Promise.withResolvers();
  return {
    pending, added: added.promise,
    scheduler: {
      setTimeout(callback, delay) { const id = {}; pending.set(id, { callback, delay }); added.resolve(); return id; },
      clearTimeout(id) { pending.delete(id); },
    },
    fire(delay) {
      const entry = [...pending].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `missing timer ${delay}`);
      pending.delete(entry[0]); entry[1].callback();
    },
  };
}

test("reads retry only opted-in transient failures with capped exponential jitter", async () => {
  const clock = timers();
  let attempts = 0;
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const work = runRead("read", async () => {
    attempts++;
    if (attempts < 3) { gates[attempts - 1].resolve(); throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
    return "ok";
  }, { timeoutMs: 0, maxRetries: 2, baseDelayMs: 20, maxDelayMs: 30, random: () => 0.5, scheduler: clock.scheduler });
  await gates[0].promise;
  // The read's rejection schedules backoff after the attempt settles.
  await clock.added;
  clock.fire(10);
  await gates[1].promise;
  await new Promise(resolve => setImmediate(resolve));
  clock.fire(15);
  assert.equal(await work, "ok");
  assert.equal(attempts, 3);
  assert.equal(clock.pending.size, 0);
});

test("reads do not replay default, permanent, parse, timeout, or cancellation failures", async () => {
  for (const [error, maxRetries] of [
    [Object.assign(new Error("busy"), { code: "EBUSY" }), 0],
    ...["EACCES", "EPERM", "ENOENT", "LNV102"].map(code => [Object.assign(new Error(code), { code }), 2]),
    [new SyntaxError("invalid JSON"), 2], [Object.assign(new Error("stop"), { name: "AbortError" }), 2],
  ]) {
    let attempts = 0;
    await assert.rejects(() => runRead("read", () => { attempts++; throw error; }, { maxRetries }), caught => caught === error);
    assert.equal(attempts, 1);
  }
});

test("one deadline bounds attempts and backoff, forwards its reason, and clears timers", async () => {
  for (const stalled of [true, false]) {
    const clock = timers();
    const started = Promise.withResolvers();
    let signal, attempts = 0;
    const work = runRead("read", options => {
      signal = options.signal; attempts++; started.resolve();
      if (stalled) return new Promise(() => {});
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }, { timeoutMs: 100, maxRetries: 2, random: () => 1, scheduler: clock.scheduler });
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    clock.fire(100);
    await assert.rejects(work, error => {
      assert.equal(error.code, "LNV102");
      assert.equal(signal.reason, error);
      return true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.equal(clock.pending.size, 0);
  }
});

test("caller cancellation reaches I/O hooks unchanged and prevents queued reads", async () => {
  const controller = new AbortController();
  const reason = new SyntaxError("caller stopped");
  const started = Promise.withResolvers();
  let ioSignal;
  const work = readText("unused", undefined, {
    signal: controller.signal,
    io: { readFile: (file, encoding, { signal }) => {
      assert.equal(file, "unused"); assert.equal(encoding, "utf8");
      ioSignal = signal; started.resolve(); return new Promise(() => {});
    } },
  });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(work, error => error === reason);
  assert.equal(ioSignal.reason, reason);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const queued = new AbortController();
  let called = false;
  const pending = runRead("read", () => { called = true; }, { signal: queued.signal });
  queued.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(called, false);
});

test("invalid read policies reject before calling I/O", async () => {
  for (const policy of [{ timeoutMs: -1 }, { timeoutMs: 2147483648 }, { maxRetries: 11 }, { baseDelayMs: NaN }, { random: 1 }]) {
    let called = false;
    await assert.rejects(() => runRead("read", () => { called = true; }, policy), TypeError);
    assert.equal(called, false);
  }
});

test("retry exhaustion preserves the final read failure without another attempt", async () => {
  let attempts = 0;
  const error = Object.assign(new Error("still busy"), { code: "EBUSY" });
  await assert.rejects(() => runRead("read", () => { attempts++; throw error; }, {
    maxRetries: 2, baseDelayMs: 0,
  }), caught => caught === error);
  assert.equal(attempts, 3);
});
