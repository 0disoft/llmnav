/* llmnav/1 module
id=llmnav.support.concurrency
role=Run independent filesystem work with a bounded number of in-flight tasks while keeping results ordered.
owns=bounded asynchronous map|deterministic failure selection|concurrency limit validation
excludes=retry policy|thread pools|request scheduling
search=bounded concurrency|parallel filesystem reads|ordered async map
invariant=Results keep input order and the lowest failing index is reported regardless of completion order.
stability=architecture
*/

import { throwIfAborted } from "./abort.js";

export const DEFAULT_IO_CONCURRENCY = 8;

export async function mapWithConcurrency(items, limit, worker, options = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`Concurrency limit must be a positive integer: ${limit}.`);
  }
  if (typeof worker !== "function") throw new TypeError("Concurrency worker must be a function.");
  const signal = options.signal;
  throwIfAborted(signal);
  const results = new Array(items.length);
  const failures = new Array(items.length);
  let nextIndex = 0;
  let stopped = false;

  async function consume() {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        throwIfAborted(signal);
        results[index] = await worker(items[index], index);
        throwIfAborted(signal);
      } catch (error) {
        failures[index] = { error };
        stopped = true;
      }
    }
  }

  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, consume));
  for (const failure of failures) {
    if (failure !== undefined) throw failure.error;
  }
  return results;
}
