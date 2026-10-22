/* llmnav/1 module
id=llmnav.support.read-operation
role=Bound idempotent reads with cooperative cancellation and opt-in transient retries.
owns=read deadlines|read retry scheduling|retry jitter
excludes=write retries|transaction recovery|shared cache ownership
search=read retry|exponential backoff|read timeout|read cancellation
invariant=Cancellation and deadline failures never start another attempt.
stability=architecture
*/

import { abortable, assertAbortSignal, createAbortError, throwIfAborted } from "./abort.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, ERROR_CODES, withDeadline } from "./errors.js";
import { MAX_TIMER_DELAY_MS, resolveScheduler } from "./runtime.js";

const TRANSIENT_READ_CODES = new Set(["EBUSY", "EAGAIN", "EMFILE", "ENFILE"]);

/** For idempotent reads only. The deadline includes attempts and backoff. */
export async function runRead(label, read, options = {}) {
  assertAbortSignal(options.signal);
  throwIfAborted(options.signal);
  const policy = readPolicy(options);
  const controller = new AbortController();
  const onAbort = () => controller.abort(createAbortError(options.signal));
  options.signal?.addEventListener("abort", onAbort);
  if (options.signal?.aborted) onAbort();
  try {
    const work = Promise.resolve().then(() => attemptRead(read, controller.signal, policy));
    return await withDeadline(label, policy.timeoutMs, work, { signal: options.signal, scheduler: policy.scheduler });
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    options.signal?.removeEventListener?.("abort", onAbort);
    controller.abort();
  }
}

function readPolicy(options) {
  const policy = {
    timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? 0,
    baseDelayMs: options.baseDelayMs ?? 25,
    maxDelayMs: options.maxDelayMs ?? 250,
    random: options.random ?? Math.random,
    retryWhen: options.retryWhen ?? ((error) => TRANSIENT_READ_CODES.has(error?.code)),
    scheduler: resolveScheduler(options.scheduler),
  };
  for (const name of ["timeoutMs", "maxRetries", "baseDelayMs", "maxDelayMs"]) {
    const maximum = name === "maxRetries" ? 10 : MAX_TIMER_DELAY_MS;
    if (!Number.isInteger(policy[name]) || policy[name] < 0 || policy[name] > maximum) {
      throw new TypeError(`Read option ${name} must be an integer between 0 and ${maximum}.`);
    }
  }
  if (typeof policy.random !== "function" || typeof policy.retryWhen !== "function") {
    throw new TypeError("Read random and retryWhen options must be functions.");
  }
  return policy;
}

async function attemptRead(read, signal, policy) {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await abortable(read({ signal }), signal);
    } catch (error) {
      throwIfAborted(signal);
      if (error?.name === "AbortError" || error?.code === ERROR_CODES.timeout || attempt >= policy.maxRetries || !policy.retryWhen(error)) throw error;
      const random = policy.random();
      if (!Number.isFinite(random) || random < 0 || random > 1) throw new TypeError("Read jitter must be between 0 and 1.");
      const delay = Math.floor(Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt) * random);
      await waitForRetry(delay, signal, policy.scheduler);
    }
  }
}

async function waitForRetry(delay, signal, scheduler) {
  let timer;
  try {
    await abortable(new Promise(resolve => { timer = scheduler.setTimeout(resolve, delay); }), signal);
  } finally {
    scheduler.clearTimeout(timer);
  }
}
