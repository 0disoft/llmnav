/* llmnav/1 module
id=llmnav.support.runtime
role=Supply injectable clock, process identity, randomness, sleep, environment, and liveness probes for deterministic tests.
owns=runtime injection|deterministic identity|process liveness
excludes=filesystem access|generation policy
search=runtime seam|injectable clock|deterministic transaction ids
stability=architecture
*/

import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { clearTimeout, setTimeout as scheduleTimeout } from "node:timers";

export const DEFAULT_SCHEDULER = Object.freeze({
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => scheduleTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
});

export const DEFAULT_RUNTIME = Object.freeze({
  now: () => Date.now(),
  pid: process.pid,
  randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  sleep: (milliseconds, options = {}) => setTimeout(milliseconds, undefined, options),
  env: () => process.env,
  isProcessAlive: (pid) => isProcessAlive(pid),
});

const RUNTIME_KEYS = Object.freeze(["now", "pid", "randomHex", "sleep", "env", "isProcessAlive"]);
const RUNTIME_FUNCTIONS = Object.freeze(["now", "randomHex", "sleep", "env", "isProcessAlive"]);

/**
 * Build an operation runtime for tests, embedders, and the CLI.
 *
 * Omitted keys keep the production behavior, so callers that pass nothing
 * observe exactly the same bytes and timings as before the seam existed.
 */
export function createRuntime(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Runtime overrides must be a plain object.");
  }
  for (const key of Object.keys(overrides)) {
    if (!RUNTIME_KEYS.includes(key)) throw new TypeError(`Unknown runtime override: ${key}.`);
  }
  for (const key of RUNTIME_FUNCTIONS) {
    if (overrides[key] !== undefined && typeof overrides[key] !== "function") {
      throw new TypeError(`Runtime override ${key} must be a function.`);
    }
  }
  if (overrides.pid !== undefined && (!Number.isInteger(overrides.pid) || overrides.pid < 1)) {
    throw new TypeError(`Runtime override pid must be a positive integer: ${overrides.pid}.`);
  }
  return Object.freeze({ ...DEFAULT_RUNTIME, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}
