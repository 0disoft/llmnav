/* llmnav/1 module
id=llmnav.support.abort
role=Expose cooperative cancellation checks so long scans, queries, and generations can stop at bounded checkpoints.
owns=abort checks|abort error normalization
excludes=cancellation sources|retry policy
search=abort signal|cancellation|abort error
stability=architecture
*/

export const ABORT_ERROR_NAME = "AbortError";

/**
 * Normalize a cancellation into one error shape.
 *
 * A provided `Error` reason is preserved, so callers keep their own cause
 * chain; anything else becomes a standard `AbortError`.
 */
export function createAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "The operation was aborted.",
  );
  error.name = ABORT_ERROR_NAME;
  return error;
}

/**
 * Throw the normalized cancellation error when the signal is already aborted.
 *
 * The check is a no-op when no signal is supplied, so optional cancellation
 * never changes the default call shape.
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal);
}

export function assertAbortSignal(signal) {
  if (signal === undefined) return;
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function"
  ) {
    throw new TypeError("Abort signal must be an AbortSignal.");
  }
}

/** Observe cancellation while consuming the work's eventual rejection as well. */
export async function abortable(promise, signal) {
  if (signal === undefined) return promise;
  assertAbortSignal(signal);
  let onAbort;
  try {
    return await new Promise((resolve, reject) => {
      Promise.resolve(promise).then(resolve, reject);
      onAbort = () => reject(createAbortError(signal));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    });
  } finally {
    signal.removeEventListener?.("abort", onAbort);
  }
}
