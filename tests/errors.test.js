import assert from "node:assert/strict";
import test from "node:test";
import {
  causeChain,
  createIoError,
  ERROR_CODES,
  isAbortError,
  isRetryableError,
  LlmnavError,
  toErrorPayload,
  withDeadline,
} from "../src/errors.js";

function filesystemError(code, message) {
  return Object.assign(new Error(message), { code });
}

test("filesystem failures keep their cause and retry classification", () => {
  const denied = filesystemError("EACCES", "permission denied");
  const wrapped = createIoError("stat", "manifest.json", denied);
  assert.ok(wrapped instanceof LlmnavError);
  assert.equal(wrapped.code, ERROR_CODES.ioRead);
  assert.equal(wrapped.operation, "stat");
  assert.equal(wrapped.cause, denied);
  assert.equal(wrapped.retryable, true);
  assert.match(wrapped.message, /^Failed to stat manifest\.json: permission denied$/u);

  const missing = createIoError("read", "index.json", filesystemError("ENOENT", "missing"));
  assert.equal(missing.retryable, false);

  const cancelled = Object.assign(new Error("stopped"), { name: "AbortError" });
  assert.equal(createIoError("read", "index.json", cancelled), cancelled);
});

test("cause chains flatten to a bounded JSON-safe payload", () => {
  const root = new LlmnavError("inner failure", { code: "LNV100" });
  const outer = new LlmnavError("outer failure", { code: "LNV101", retryable: true, cause: root });

  assert.deepEqual(causeChain(outer), [
    { name: "LlmnavError", code: "LNV101", message: "outer failure" },
    { name: "LlmnavError", code: "LNV100", message: "inner failure" },
  ]);
  assert.deepEqual(toErrorPayload(outer), {
    code: "LNV101",
    retryable: true,
    cause: [{ name: "LlmnavError", code: "LNV100", message: "inner failure" }],
  });
  assert.equal(toErrorPayload(new Error("plain")).code, null);
  assert.equal(isRetryableError(filesystemError("EBUSY", "busy")), true);
  assert.equal(isRetryableError(new Error("plain")), false);
  assert.equal(isAbortError(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(isAbortError(new Error("x")), false);
});

test("a deadline reports a timeout without cancelling the work", async () => {
  const slow = new Promise(() => {});
  await assert.rejects(withDeadline("query request", 5, slow), (error) => {
    assert.equal(error.code, ERROR_CODES.timeout);
    assert.equal(error.retryable, false);
    assert.match(error.message, /^query request did not finish within 5 ms\.$/u);
    return true;
  });
  assert.equal(await withDeadline("query", 0, Promise.resolve(7)), 7);
  assert.equal(await withDeadline("query", 50, Promise.resolve(8)), 8);
  await assert.rejects(withDeadline("query", -1, Promise.resolve()), /must be a non-negative integer/u);

  const controller = new AbortController();
  const cancelled = withDeadline("query", 1_000, new Promise(() => {}), { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, (error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("aggregate failures retain their original errors in bounded wire details", () => {
  const disk = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const cleanup = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
  const error = new AggregateError([disk, cleanup], "write and cleanup failed");
  const payload = toErrorPayload(error);
  assert.deepEqual(payload.errors.map(chain => chain[0].code), ["ENOSPC", "EACCES"]);
  error.errors.push(error);
  assert.doesNotThrow(() => JSON.stringify(toErrorPayload(error)));
  let nested = error;
  for (let index = 0; index < 100; index++) nested = new AggregateError([nested, nested], "nested");
  assert.ok(JSON.stringify(toErrorPayload(nested)).length < 5000);
});

test("a cause cycle still yields a finite chain", () => {
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;
  assert.equal(causeChain(second).length, 2);
  assert.equal(causeChain(second)[0].message, "second");
});

test("deadlines honor pre-cancellation, disabled timeouts, and structural signals", async () => {
  const controller = new AbortController();
  const reason = new Error("caller stopped");
  controller.abort(reason);
  for (const timeout of [0, 1]) {
    await assert.rejects(withDeadline("query", timeout, Promise.resolve(7), { signal: controller.signal }), (error) => error === reason);
  }
  const late = new AbortController();
  const pending = withDeadline("query", 0, new Promise(() => {}), { signal: late.signal });
  late.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(await withDeadline("query", 1, Promise.resolve(7), {
    signal: { aborted: false, addEventListener() {} },
  }), 7);
  for (const timeout of [-1, 0.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(withDeadline("query", timeout, Promise.resolve()), TypeError);
  }
  assert.equal(await withDeadline("query", 2_147_483_647, Promise.resolve(7)), 7);
});

test("injected deadline timers fire deterministically and clean abort listeners", async () => {
  let fire;
  let cleared = 0;
  const listeners = new Set();
  const scheduler = {
    setTimeout(callback, delay) { assert.equal(delay, 10); fire = callback; return 1; },
    clearTimeout(timer) { assert.equal(timer, 1); cleared += 1; },
  };
  const signal = {
    aborted: false,
    addEventListener(type, listener) { listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
  };
  const timed = withDeadline("query", 10, new Promise(() => {}), { scheduler, signal });
  fire();
  await assert.rejects(timed, { code: "LNV102" });
  assert.equal(cleared, 1);
  assert.equal(listeners.size, 0);
});

test("scheduler defaults survive undefined hooks and clear opaque null timer handles", async () => {
  assert.equal(await withDeadline("query", 10, Promise.resolve(7), { scheduler: { setTimeout: undefined } }), 7);
  let cleared = false;
  assert.equal(await withDeadline("query", 10, Promise.resolve(7), {
    scheduler: {
      setTimeout: () => null,
      clearTimeout: (handle) => { assert.equal(handle, null); cleared = true; },
    },
  }), 7);
  assert.equal(cleared, true);
});
