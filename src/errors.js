/* llmnav/1 module
id=llmnav.support.errors
role=Describe failures with a stable code, retry classification, cause chain, and bounded operation deadline.
owns=error codes|cause chains|retry classification|operation deadlines
excludes=diagnostics reporting|CLI formatting|retry scheduling
search=error cause|retryable failure|error code chain|operation deadline
invariant=Every wrapped failure keeps the original error as its cause.
stability=contract
*/

import { abortable } from "./abort.js";
import { MAX_TIMER_DELAY_MS, resolveScheduler } from "./runtime.js";

export const ERROR_CODES = Object.freeze({
  ioRead: "LNV100",
  ioWrite: "LNV101",
  timeout: "LNV102",
});

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

// Filesystem codes that a later attempt can plausibly survive on the same host.
const TRANSIENT_ERROR_CODES = new Set(["EACCES", "EBUSY", "EAGAIN", "EMFILE", "ENFILE", "EPERM"]);

/**
 * A failure that carries its own code, retryability, and original cause.
 *
 * The cause chain is the only reliable way to explain a wrapped filesystem
 * failure, so callers should never replace it with a bare message.
 */
export class LlmnavError extends Error {
  constructor(message, { code = null, operation = null, retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LlmnavError";
    this.code = code;
    this.operation = operation;
    this.retryable = retryable;
  }
}

export function isAbortError(error) {
  return Boolean(error && typeof error === "object" && error.name === "AbortError");
}

export function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : null;
}

/**
 * Decide whether another attempt is safe for this failure.
 *
 * Only transient filesystem codes and errors that explicitly declare
 * themselves retryable qualify; everything else must surface immediately.
 */
export function isRetryableError(error) {
  const code = errorCode(error);
  if (code !== null && TRANSIENT_ERROR_CODES.has(code)) return true;
  return Boolean(error && typeof error === "object" && error.retryable === true);
}

/** Wrap a failed read; cancellations pass through untouched. */
export function createIoError(operation, target, cause) {
  if (isAbortError(cause)) return cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new LlmnavError(`Failed to ${operation} ${target}: ${reason}`, {
    code: ERROR_CODES.ioRead,
    operation,
    retryable: isRetryableError(cause),
    cause,
  });
}

/** Flatten a cause chain, oldest errors last, with bounded depth. */
export function causeChain(error) {
  return collectCauses(error, { remaining: 32 }, 0);
}

function collectCauses(error, budget, depth, ancestors = new Set()) {
  const chain = [];
  const seen = new Set(ancestors);
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current) && chain.length < 8 && depth < 8 && budget.remaining > 0) {
    seen.add(current);
    budget.remaining -= 1;
    const link = {
      name: typeof current.name === "string" ? current.name : null,
      code: errorCode(current),
      message: typeof current.message === "string" ? current.message : String(current),
    };
    if (current instanceof AggregateError) {
      link.errors = current.errors.slice(0, 8).map((cause) => collectCauses(cause, budget, depth + 1, seen));
    }
    chain.push(link);
    current = current.cause;
  }
  return chain;
}

/** Build the JSON-safe payload that hosts and CLI debugging consume. */
export function toErrorPayload(error) {
  const chain = causeChain(error);
  return {
    code: chain[0]?.code ?? null,
    retryable: isRetryableError(error),
    cause: chain.slice(1),
    ...(chain[0]?.errors === undefined ? {} : { errors: chain[0].errors }),
  };
}

/**
 * Reject an operation that runs past its deadline.
 *
 * A timeout cannot cancel a filesystem syscall, so apply this to reads only:
 * reporting a write as timed out while it later succeeds would be a lie.
 */
export async function withDeadline(operation, timeoutMs, promise, options = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`Operation deadline for ${operation} must be a non-negative integer <= 2147483647: ${timeoutMs}.`);
  }
  if (timeoutMs === 0) return abortable(promise, options.signal);
  const scheduler = resolveScheduler(options.scheduler);
  let timer;
  let scheduled = false;
  try {
    return await abortable(Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = scheduler.setTimeout(() => {
          reject(new LlmnavError(`${operation} did not finish within ${timeoutMs} ms.`, {
            code: ERROR_CODES.timeout,
            operation,
            retryable: false,
          }));
        }, timeoutMs);
        scheduled = true;
      }),
    ]), options.signal);
  } finally {
    if (scheduled) scheduler.clearTimeout(timer);
  }
}
