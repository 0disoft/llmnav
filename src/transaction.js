/* llmnav/1 module
id=llmnav.index.transaction
role=Commit a complete generated cache with rollback and crash recovery across POSIX and Windows rename behavior.
owns=cache staging|directory swap|generation recovery
excludes=artifact semantics|source indexing
search=transactional generation|atomic cache swap|Windows rename recovery
rel=workflow>llmnav.index.generate
stability=architecture
*/

import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertNoSymlinkTraversal,
  atomicWrite,
  compareText,
  readJson,
  readJsonSafe,
  projectRelativePath,
  relativePosix,
  sha256,
  stableStringify,
  toPosix,
} from "./util.js";
import { throwIfAborted } from "./abort.js";
import { DEFAULT_RUNTIME } from "./runtime.js";

export const TRANSACTION_SCHEMA_VERSION = 1;
export const TRANSACTION_ABORT_EXIT_CODE = 86;

/**
 * Crash-equivalent interruption raised by the `abort:<phase>` failpoint.
 *
 * The library never terminates the host process: the error carries the exit
 * code the CLI maps back to, so embedders can decide how to unwind.
 */
export class TransactionAbortError extends Error {
  constructor(phase) {
    super(`Generation was interrupted at ${phase}.`);
    this.name = "TransactionAbortError";
    this.code = "LLMNAV_ABORTED";
    this.phase = phase;
    this.exitCode = TRANSACTION_ABORT_EXIT_CODE;
  }
}
const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]);
const DEFAULT_RETRY_DELAYS = Object.freeze([0, 8, 16, 32, 64, 128, 256, 512]);
const JOURNAL_PHASES = new Set(["prepared", "old-moved", "new-installed", "committed"]);
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 50;
const LOCK_LINK_CAPABILITY_ERRORS = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]);
const CONTROL_ARTIFACT_PATHS = new Set([".llmnav/ids.jsonl", ".llmnav/order.lock"]);

export async function withGenerationLock(root, callback, options = {}) {
  const lock = await acquireGenerationLock(root, options);
  let result;
  let failure;
  try {
    result = await callback(lock);
  } catch (error) {
    failure = error;
  }
  // Releasing is part of the operation's contract: a callback error must not
  // hide a release error, and a release error must not leave a live-pid lock
  // behind that blocks every later generation in this process.
  const releaseFailure = await releaseGenerationLockSettled(lock);
  if (failure !== undefined && releaseFailure !== undefined) {
    throw new AggregateError([failure, releaseFailure], "Generation failed and its lock could not be released.");
  }
  if (failure !== undefined) throw failure;
  if (releaseFailure !== undefined) throw releaseFailure;
  return result;
}

const LOCK_RELEASE_RETRY_DELAYS = Object.freeze([0, 8, 16]);

async function releaseGenerationLockSettled(lock) {
  const runtime = lock.runtime ?? DEFAULT_RUNTIME;
  let failure;
  for (const delay of LOCK_RELEASE_RETRY_DELAYS) {
    if (delay > 0) await runtime.sleep(delay);
    try {
      await releaseGenerationLock(lock);
      return undefined;
    } catch (error) {
      failure = error;
    }
  }
  // The lock still names this process, so removal cannot steal another owner's
  // lock: finishing without it would only strand the next generation.
  try {
    const observed = await readLockRecord(lock.lockPath);
    if (observed.missing) return undefined;
    if (observed.record?.ownerId === lock.ownerId) {
      await rm(lock.lockPath, { force: true });
      return undefined;
    }
  } catch {
    // Report the original release failure instead of the fallback cleanup error.
  }
  return failure;
}

export async function acquireGenerationLock(root, options = {}) {
  const controlDirectory = path.join(root, ".llmnav");
  const lockPath = path.join(controlDirectory, "generation.lock");
  await assertNoSymlinkTraversal(root, controlDirectory, ".llmnav");
  await assertNoSymlinkTraversal(root, lockPath, ".llmnav/generation.lock");
  await mkdir(controlDirectory, { recursive: true });
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const ownerId = options.ownerId ?? createTransactionId(runtime);
  const timeoutMs = requireLockInteger("timeoutMs", options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 0);
  const pollMs = requireLockInteger("pollMs", options.pollMs, DEFAULT_LOCK_POLL_MS, 1);
  const delays = options.delays ?? [0, ...Array.from({ length: Math.ceil(timeoutMs / pollMs) }, () => pollMs)];
  requireLockDelays(delays);
  const openImpl = options.openImpl ?? open;
  const linkImpl = options.linkImpl ?? link;
  const sleepImpl = options.sleepImpl ?? runtime.sleep;
  const candidatePath = `${lockPath}.tmp-${runtime.pid}-${runtime.randomHex(8)}`;
  // Publish only a closed, complete owner record. A crash before publication
  // leaves an unused candidate, never an unreadable authoritative lock.
  let candidateCreated = false;
  try {
    const handle = await openImpl(candidatePath, "wx");
    candidateCreated = true;
    try {
      await handle.writeFile(stableStringify({ schemaVersion: 1, ownerId, pid: runtime.pid }));
      await handle.sync();
    } finally {
      await handle.close();
    }

    for (const delay of delays) {
      if (delay > 0) await sleepImpl(delay);
      try {
        await linkImpl(candidatePath, lockPath);
        return { root, lockPath, ownerId, runtime };
      } catch (error) {
        if (error && typeof error === "object" && LOCK_LINK_CAPABILITY_ERRORS.has(error.code)) {
          throw new Error(
            `Cannot publish the LLMNav generation lock (${error.code}). The repository filesystem must support hard links and permit their creation. Check filesystem permissions or move the repository to a filesystem with hard-link support.`,
            { cause: error },
          );
        }
        if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
        const observed = await readLockRecord(lockPath);
        if (observed.missing) continue;
        if (!isOwnedLockRecord(observed.record)) throw invalidOwnerRecordError();
        if (!runtime.isProcessAlive(observed.record.pid)) {
          await removeOwnedLock(lockPath, observed.record.ownerId, runtime);
          // Reclaiming a dead owner must not cost another full poll interval.
          try {
            await linkImpl(candidatePath, lockPath);
            return { root, lockPath, ownerId, runtime };
          } catch (retryError) {
            if (!retryError || typeof retryError !== "object" || retryError.code !== "EEXIST") throw retryError;
          }
        }
      }
    }
    const observed = await readLockRecord(lockPath);
    if (observed.missing) throw new Error("Timed out waiting for the LLMNav generation lock.");
    if (!isOwnedLockRecord(observed.record)) throw invalidOwnerRecordError();
    throw new Error("Timed out waiting for the LLMNav generation lock.");
  } finally {
    // Candidate cleanup must not turn successful acquisition into a leaked lock.
    if (candidateCreated) await removeWithRetry(candidatePath).catch(() => {});
  }
}

export async function releaseGenerationLock(lock) {
  await removeOwnedLock(lock.lockPath, lock.ownerId, lock.runtime ?? DEFAULT_RUNTIME);
}

export async function commitGeneratedCache(root, cacheDirectory, artifacts, options = {}) {
  throwIfAborted(options.signal);
  if (!options.lockOwnerId) {
    return withGenerationLock(
      root,
      (lock) => commitGeneratedCache(root, cacheDirectory, artifacts, { ...options, lockOwnerId: lock.ownerId }),
      options.lockOptions,
    );
  }
  const transaction = await openTransaction(root, cacheDirectory, options);
  try {
    await stageArtifacts(transaction, artifacts, options);
    transaction.controlRecords = await stageControlArtifacts(
      root,
      transaction.transactionPath,
      options.controlArtifacts,
    );
    await invokeFailpoint("after-stage", options);
    await persistJournal(transaction, options, "prepared");
    await invokeFailpoint("after-journal", options);
    await moveCacheAside(transaction, options);
    await installCache(transaction, options);
    await finalizeTransaction(transaction, options);
    return {
      committed: true,
      skipped: false,
      recovered: transaction.recovery.recovered,
      recoveryAction: transaction.recovery.action,
      transactionId: transaction.transactionId,
      replacedExisting: transaction.hadExistingCache,
    };
  } catch (error) {
    return failTransaction(error, transaction, options);
  }
}

async function openTransaction(root, cacheDirectory, options) {
  const cacheRelative = projectRelativePath(cacheDirectory, "cacheDirectory");
  const cachePath = path.join(root, cacheRelative);
  const controlDirectory = path.join(root, ".llmnav");
  const transactionsDirectory = path.join(controlDirectory, ".transactions");
  const journalPath = path.join(controlDirectory, "generation-transaction.json");
  await assertNoSymlinkTraversal(root, controlDirectory, ".llmnav");
  await assertNoSymlinkTraversal(root, transactionsDirectory, ".llmnav/.transactions");
  await assertNoSymlinkTraversal(root, journalPath, ".llmnav/generation-transaction.json");
  await assertNoSymlinkTraversal(root, cachePath, cacheRelative);
  const recovery = await recoverGenerationTransaction(root, {
    cacheDirectory: cacheRelative,
    renameOptions: options.renameOptions,
    lockOwnerId: options.lockOwnerId,
  });

  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const transactionId = options.transactionId ?? createTransactionId(runtime);
  const transactionPath = path.join(transactionsDirectory, transactionId);
  const stagePath = path.join(transactionPath, "stage");
  const backupPath = path.join(transactionPath, "backup");
  await assertNoSymlinkTraversal(root, transactionPath, relativePosix(root, transactionPath));
  const hadExistingCache = await pathExists(cachePath);
  await mkdir(stagePath, { recursive: true });
  return {
    root,
    cacheRelative,
    cachePath,
    transactionsDirectory,
    journalPath,
    transactionId,
    transactionPath,
    stagePath,
    backupPath,
    hadExistingCache,
    recovery,
    controlRecords: [],
    journal: null,
  };
}

async function stageArtifacts(transaction, artifacts, options) {
  const cachePrefix = `${transaction.cacheRelative.replace(/\/+$/u, "")}/`;
  const cacheArtifacts = [...artifacts.entries()]
    .filter(([relativePath]) => toPosix(relativePath).startsWith(cachePrefix))
    .sort(([left], [right]) => compareText(toPosix(left), toPosix(right)));
  if (cacheArtifacts.length === 0) {
    throw new Error(`No generated artifacts target ${transaction.cacheRelative}.`);
  }
  for (const [relativePath, content] of cacheArtifacts) {
    const normalized = projectRelativePath(relativePath, `Generated artifact ${relativePath}`);
    const stageRelative = normalized.slice(cachePrefix.length);
    if (!normalized.startsWith(cachePrefix) || !stageRelative) {
      throw new Error(`Generated artifact ${normalized} escapes the staged cache.`);
    }
    const destination = path.join(transaction.stagePath, ...stageRelative.split("/"));
    const relativeDestination = path.relative(transaction.stagePath, path.resolve(destination));
    if (relativeDestination === ".." || relativeDestination.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDestination)) {
      throw new Error(`Generated artifact ${normalized} escapes the staged cache.`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
    await invokeFailpoint(`after-write:${stageRelative}`, options);
  }
  await verifyStagedArtifacts(transaction.stagePath, cacheArtifacts, cachePrefix);
}

function journalRecord(transaction, options, phase) {
  return {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    cacheDirectory: transaction.cacheRelative,
    transactionDirectory: relativePosix(transaction.root, transaction.transactionPath),
    stageDirectory: relativePosix(transaction.root, transaction.stagePath),
    backupDirectory: relativePosix(transaction.root, transaction.backupPath),
    hadExistingCache: transaction.hadExistingCache,
    ownerId: options.lockOwnerId,
    controlArtifacts: transaction.controlRecords,
    phase,
  };
}

async function persistJournal(transaction, options, phase) {
  transaction.journal = journalRecord(transaction, options, phase);
  await atomicWrite(transaction.root, transaction.journalPath, stableStringify(transaction.journal));
}

async function moveCacheAside(transaction, options) {
  if (transaction.hadExistingCache) {
    await renameWithRetry(transaction.cachePath, transaction.backupPath, options.renameOptions);
  }
  await moveControlArtifactsToBackup(transaction.root, transaction.controlRecords, options.renameOptions);
  await persistJournal(transaction, options, "old-moved");
  await invokeFailpoint("after-cache-moved", options);
}

async function installCache(transaction, options) {
  await renameWithRetry(transaction.stagePath, transaction.cachePath, options.renameOptions);
  await installControlArtifacts(transaction.root, transaction.controlRecords, options.renameOptions);
  await persistJournal(transaction, options, "new-installed");
  await verifyCommittedCache(transaction.cachePath, transaction.cacheRelative);
  await verifyControlArtifacts(transaction.root, transaction.controlRecords);
  await invokeFailpoint("after-new-installed", options);
}

async function finalizeTransaction(transaction, options) {
  await persistJournal(transaction, options, "committed");
  if (transaction.hadExistingCache) {
    await removeWithRetry(transaction.backupPath, options.renameOptions);
  }
  await removeWithRetry(transaction.transactionPath, options.renameOptions);
  await removeWithRetry(transaction.journalPath, options.renameOptions);
  await cleanupEmptyTransactionsDirectory(transaction.transactionsDirectory);
}

async function failTransaction(error, transaction, options) {
  // An abort failpoint reproduces a crash: the journal must survive so the
  // next read or generation can recover the interrupted swap.
  if (error instanceof TransactionAbortError) throw error;
  const journal = await readJournalForRollback(transaction.journalPath);
  const ownedJournal = journal?.ownerId === options.lockOwnerId ? journal : null;
  if (ownedJournal?.phase !== "committed") {
    const fallback = journalRecord(transaction, options, "prepared");
    try {
      await rollbackTransaction(
        transaction.root,
        ownedJournal ?? fallback,
        transaction.cacheRelative,
        options.renameOptions,
      );
    } catch (rollbackError) {
      const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new AggregateError([error, rollbackError], `Generation failed and rollback also failed: ${message}`);
    }
  }
  throw error;
}

export async function recoverGenerationTransaction(root, options = {}) {
  if (!options.lockOwnerId) {
    return withGenerationLock(
      root,
      (lock) => recoverGenerationTransaction(root, { ...options, lockOwnerId: lock.ownerId }),
      options.lockOptions,
    );
  }
  const controlDirectory = path.join(root, ".llmnav");
  await assertNoSymlinkTraversal(root, controlDirectory, ".llmnav");
  const journalPath = path.join(controlDirectory, "generation-transaction.json");
  await assertNoSymlinkTraversal(root, journalPath, ".llmnav/generation-transaction.json");
  if (options.cacheDirectory) {
    const configuredCacheDirectory = projectRelativePath(options.cacheDirectory, "cacheDirectory");
    await assertNoSymlinkTraversal(root, path.join(root, configuredCacheDirectory), configuredCacheDirectory);
  }
  const journal = await readJson(journalPath, null);
  if (!journal) return { recovered: false, action: "none" };
  validateJournal(root, journal, options.cacheDirectory);

  const cachePath = path.join(root, journal.cacheDirectory);
  const stagePath = path.join(root, journal.stageDirectory);
  const backupPath = path.join(root, journal.backupDirectory);
  const transactionPath = path.join(root, journal.transactionDirectory);
  await assertNoSymlinkTraversal(root, cachePath, journal.cacheDirectory);
  await assertNoSymlinkTraversal(root, transactionPath, journal.transactionDirectory);
  await assertNoSymlinkTraversal(root, stagePath, journal.stageDirectory);
  await assertNoSymlinkTraversal(root, backupPath, journal.backupDirectory);
  let action = "cleanup";

  if (journal.phase === "committed") {
    if (await pathExists(cachePath)) {
      action = "finalized-committed-cache";
    } else if (await pathExists(stagePath)) {
      await renameWithRetry(stagePath, cachePath, options.renameOptions);
      action = "installed-committed-stage";
    } else if (await pathExists(backupPath)) {
      await renameWithRetry(backupPath, cachePath, options.renameOptions);
      action = "restored-backup-after-missing-commit";
    }
    await finalizeCommittedControlArtifacts(root, journal.controlArtifacts ?? [], options.renameOptions);
  } else if (await pathExists(backupPath)) {
    if (await pathExists(cachePath)) await removeWithRetry(cachePath, options.renameOptions);
    await renameWithRetry(backupPath, cachePath, options.renameOptions);
    action = "restored-previous-cache";
  } else if (journal.hadExistingCache && await pathExists(cachePath)) {
    action = "kept-existing-cache";
  } else if (!journal.hadExistingCache && await pathExists(cachePath)) {
    await verifyCommittedCache(cachePath, journal.cacheDirectory);
    action = "kept-first-generated-cache";
  } else if (!journal.hadExistingCache && await pathExists(stagePath)) {
    await verifyCommittedCache(stagePath, journal.cacheDirectory);
    await renameWithRetry(stagePath, cachePath, options.renameOptions);
    action = "completed-first-generation";
  } else {
    action = "removed-incomplete-transaction";
  }

  if (journal.phase !== "committed") {
    await restoreControlArtifacts(root, journal.controlArtifacts ?? [], options.renameOptions);
  }

  await removeWithRetry(transactionPath, options.renameOptions);
  await removeWithRetry(journalPath, options.renameOptions);
  await cleanupEmptyTransactionsDirectory(path.dirname(transactionPath));
  return { recovered: true, action };
}

export async function renameWithRetry(source, destination, options = {}) {
  const renameImpl = options.renameImpl ?? rename;
  const delays = options.delays ?? DEFAULT_RETRY_DELAYS;
  let lastError;
  for (const delay of delays) {
    if (delay > 0) await (options.sleepImpl ?? sleep)(delay);
    try {
      await renameImpl(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error)) throw error;
    }
  }
  throw lastError;
}

export async function removeWithRetry(target, options = {}) {
  const rmImpl = options.rmImpl ?? rm;
  const delays = options.delays ?? DEFAULT_RETRY_DELAYS;
  let lastError;
  for (const delay of delays) {
    if (delay > 0) await (options.sleepImpl ?? sleep)(delay);
    try {
      await rmImpl(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error)) throw error;
    }
  }
  throw lastError;
}

async function rollbackTransaction(root, journal, expectedCacheDirectory, renameOptions) {
  validateJournal(root, journal, expectedCacheDirectory);
  const cachePath = path.join(root, journal.cacheDirectory);
  const stagePath = path.join(root, journal.stageDirectory);
  const backupPath = path.join(root, journal.backupDirectory);
  const transactionPath = path.join(root, journal.transactionDirectory);
  const journalPath = path.join(root, ".llmnav", "generation-transaction.json");

  if (await pathExists(backupPath)) {
    if (await pathExists(cachePath)) await removeWithRetry(cachePath, renameOptions);
    await renameWithRetry(backupPath, cachePath, renameOptions);
  } else if (!journal.hadExistingCache && await pathExists(cachePath)) {
    await removeWithRetry(cachePath, renameOptions);
  }
  await restoreControlArtifacts(root, journal.controlArtifacts ?? [], renameOptions);
  if (await pathExists(stagePath)) await removeWithRetry(stagePath, renameOptions);
  await removeWithRetry(transactionPath, renameOptions);
  await removeWithRetry(journalPath, renameOptions);
  await cleanupEmptyTransactionsDirectory(path.dirname(transactionPath));
}

async function verifyStagedArtifacts(stagePath, artifacts, cachePrefix) {
  for (const [relativePath, expected] of artifacts) {
    const normalized = projectRelativePath(relativePath, `Generated artifact ${relativePath}`);
    if (!normalized.startsWith(cachePrefix)) throw new Error(`Generated artifact ${normalized} escapes the staged cache.`);
    const stageRelative = normalized.slice(cachePrefix.length);
    const actual = await readFile(path.join(stagePath, ...stageRelative.split("/")), "utf8");
    if (actual !== expected) throw new Error(`Staged artifact ${relativePath} does not match generated bytes.`);
  }
  await verifyCommittedCache(stagePath, cachePrefix.slice(0, -1));
}

async function verifyCommittedCache(cachePath, cacheDirectory) {
  const manifest = JSON.parse(await readFile(path.join(cachePath, "manifest.json"), "utf8"));
  for (const [relativePath, expectedHash] of Object.entries(manifest.files ?? {}).sort(([left], [right]) => compareText(left, right))) {
    const normalized = projectRelativePath(relativePath, `Manifest path ${relativePath}`);
    const prefix = `${toPosix(cacheDirectory).replace(/\/+$/u, "")}/`;
    if (!normalized.startsWith(prefix)) throw new Error(`Manifest path ${relativePath} is outside ${cacheDirectory}.`);
    const cacheRelative = normalized.slice(prefix.length);
    const content = await readFile(path.join(cachePath, ...cacheRelative.split("/")), "utf8");
    if (sha256(content) !== expectedHash) throw new Error(`Generated artifact ${relativePath} fails manifest verification.`);
  }
  const index = JSON.parse(await readFile(path.join(cachePath, "index.json"), "utf8"));
  if (index?.schemaVersion !== 1 || !Array.isArray(index.cards)) {
    throw new Error("Generated index.json is not a compatible schemaVersion 1 index.");
  }
}

function validateJournal(root, journal, expectedCacheDirectory) {
  if (!journal || journal.schemaVersion !== TRANSACTION_SCHEMA_VERSION) {
    throw new Error("Unsupported or malformed LLMNav generation transaction journal.");
  }
  for (const key of ["cacheDirectory", "transactionDirectory", "stageDirectory", "backupDirectory"]) {
    if (typeof journal[key] !== "string" || !journal[key] || path.isAbsolute(journal[key])) {
      throw new Error(`Generation transaction journal has invalid ${key}.`);
    }
    const resolved = path.resolve(root, journal[key]);
    const relative = path.relative(path.resolve(root), resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Generation transaction journal ${key} escapes the repository root.`);
    }
  }
  if (!expectedCacheDirectory) {
    throw new Error("Generation transaction recovery requires the configured cache directory.");
  }
  if (toPosix(journal.cacheDirectory) !== toPosix(expectedCacheDirectory)) {
    throw new Error("Generation transaction cache directory does not match project configuration.");
  }
  const transactionDirectory = toPosix(journal.transactionDirectory);
  if (!/^\.llmnav\/\.transactions\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(transactionDirectory)) {
    throw new Error("Generation transaction directory must be one direct child of .llmnav/.transactions.");
  }
  if (toPosix(journal.stageDirectory) !== `${transactionDirectory}/stage`) {
    throw new Error("Generation transaction stage directory does not belong to its transaction.");
  }
  if (toPosix(journal.backupDirectory) !== `${transactionDirectory}/backup`) {
    throw new Error("Generation transaction backup directory does not belong to its transaction.");
  }
  if (typeof journal.hadExistingCache !== "boolean") {
    throw new Error("Generation transaction journal has invalid hadExistingCache.");
  }
  if (journal.ownerId !== undefined && (typeof journal.ownerId !== "string" || !journal.ownerId)) {
    throw new Error("Generation transaction journal has invalid ownerId.");
  }
  validateControlArtifacts(journal, transactionDirectory);
  if (!JOURNAL_PHASES.has(journal.phase)) {
    throw new Error("Generation transaction journal has invalid phase.");
  }
}

async function stageControlArtifacts(root, transactionPath, artifacts = new Map()) {
  const records = [];
  for (const [relativePath, content] of [...artifacts.entries()].sort(([left], [right]) => compareText(left, right))) {
    const normalized = projectRelativePath(relativePath, `Control artifact ${relativePath}`);
    if (!CONTROL_ARTIFACT_PATHS.has(normalized)) {
      throw new Error(`Control artifact ${normalized} is not transaction-managed.`);
    }
    const name = path.posix.basename(normalized);
    const stagePath = path.join(transactionPath, "control-stage", name);
    const backupPath = path.join(transactionPath, "control-backup", name);
    await mkdir(path.dirname(stagePath), { recursive: true });
    await writeFile(stagePath, content, "utf8");
    records.push({
      path: normalized,
      stagePath: relativePosix(root, stagePath),
      backupPath: relativePosix(root, backupPath),
      hadExisting: await pathExists(path.join(root, normalized)),
      hash: sha256(content),
    });
  }
  return records;
}

async function moveControlArtifactsToBackup(root, records, renameOptions) {
  for (const record of records) {
    if (!record.hadExisting) continue;
    const backupPath = path.join(root, record.backupPath);
    await mkdir(path.dirname(backupPath), { recursive: true });
    await renameWithRetry(path.join(root, record.path), backupPath, renameOptions);
  }
}

async function installControlArtifacts(root, records, renameOptions) {
  for (const record of records) {
    await renameWithRetry(path.join(root, record.stagePath), path.join(root, record.path), renameOptions);
  }
}

async function verifyControlArtifacts(root, records) {
  for (const record of records) {
    const content = await readFile(path.join(root, record.path), "utf8");
    if (sha256(content) !== record.hash) throw new Error(`Control artifact ${record.path} fails transaction verification.`);
  }
}

async function restoreControlArtifacts(root, records, renameOptions) {
  for (const record of records) {
    const targetPath = path.join(root, record.path);
    const backupPath = path.join(root, record.backupPath);
    if (await pathExists(backupPath)) {
      if (await pathExists(targetPath)) await removeWithRetry(targetPath, renameOptions);
      await renameWithRetry(backupPath, targetPath, renameOptions);
    } else if (!record.hadExisting && await pathExists(targetPath)) {
      await removeWithRetry(targetPath, renameOptions);
    }
  }
}

async function finalizeCommittedControlArtifacts(root, records, renameOptions) {
  for (const record of records) {
    const targetPath = path.join(root, record.path);
    const stagePath = path.join(root, record.stagePath);
    const backupPath = path.join(root, record.backupPath);
    if (!await pathExists(targetPath) && await pathExists(stagePath)) {
      await renameWithRetry(stagePath, targetPath, renameOptions);
    } else if (!await pathExists(targetPath) && await pathExists(backupPath)) {
      await renameWithRetry(backupPath, targetPath, renameOptions);
    }
  }
  await verifyControlArtifacts(root, records);
}

function validateControlArtifacts(journal, transactionDirectory) {
  if (journal.controlArtifacts === undefined) return;
  if (!Array.isArray(journal.controlArtifacts)) {
    throw new Error("Generation transaction journal has invalid controlArtifacts.");
  }
  const seen = new Set();
  for (const record of journal.controlArtifacts) {
    if (!record || typeof record !== "object" || !CONTROL_ARTIFACT_PATHS.has(toPosix(record.path))) {
      throw new Error("Generation transaction journal has an invalid control artifact path.");
    }
    if (seen.has(record.path)) throw new Error("Generation transaction journal repeats a control artifact path.");
    seen.add(record.path);
    const name = path.posix.basename(toPosix(record.path));
    if (toPosix(record.stagePath) !== `${transactionDirectory}/control-stage/${name}` ||
        toPosix(record.backupPath) !== `${transactionDirectory}/control-backup/${name}`) {
      throw new Error("Generation transaction control artifact does not belong to its transaction.");
    }
    if (typeof record.hadExisting !== "boolean" || !/^[a-f0-9]{64}$/u.test(record.hash)) {
      throw new Error("Generation transaction journal has invalid control artifact metadata.");
    }
  }
}

async function removeOwnedLock(lockPath, ownerId, runtime = DEFAULT_RUNTIME) {
  const quarantinePath = `${lockPath}.release-${ownerId}-${runtime.randomHex(4)}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
  const current = await readJsonSafe(quarantinePath, null);
  if (current?.ownerId === ownerId) {
    await rm(quarantinePath, { force: true });
    return true;
  }
  try {
    await rename(quarantinePath, lockPath);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    await rm(quarantinePath, { force: true });
  }
  return false;
}

function requireLockInteger(name, value, fallback, minimum) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum) {
    throw new TypeError(`Generation lock option ${name} must be an integer >= ${minimum}: ${resolved}.`);
  }
  return resolved;
}

function requireLockDelays(delays) {
  if (!Array.isArray(delays) || delays.length === 0 || delays.some((delay) => !Number.isInteger(delay) || delay < 0)) {
    throw new TypeError("Generation lock option delays must be a non-empty array of non-negative integers.");
  }
}

async function readLockRecord(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { missing: true, record: null };
    throw error;
  }
  try {
    return { missing: false, record: JSON.parse(raw) };
  } catch {
    return { missing: false, record: null };
  }
}

function isOwnedLockRecord(record) {
  return Boolean(
    record
    && typeof record === "object"
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.ownerId === "string"
    && record.ownerId.length > 0,
  );
}

function invalidOwnerRecordError() {
  return new Error("The LLMNav generation lock has no valid owner record. After stopping all LLMNav processes, remove .llmnav/generation.lock and retry.");
}

async function invokeFailpoint(name, options) {
  throwIfAborted(options.signal);
  if (typeof options.onPhase === "function") await options.onPhase(name);
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const failpoint = options.failpoint ?? runtime.env().LLMNAV_TEST_FAILPOINT;
  if (failpoint === `throw:${name}`) throw new Error(`Injected generation failure at ${name}.`);
  if (failpoint === `abort:${name}`) throw new TransactionAbortError(name);
}

function isRetryableRenameError(error) {
  return Boolean(error && typeof error === "object" && RETRYABLE_RENAME_CODES.has(error.code));
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupEmptyTransactionsDirectory(directory) {
  try {
    const details = await stat(directory);
    if (!details.isDirectory()) return;
    const entries = await readdir(directory);
    if (entries.length === 0) await rm(directory, { recursive: true, force: true });
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
}

async function readJournalForRollback(journalPath) {
  try {
    return await readJson(journalPath, null);
  } catch {
    // A damaged journal must not mask the failure that stopped generation.
    return null;
  }
}

function createTransactionId(runtime = DEFAULT_RUNTIME) {
  return `${runtime.pid}-${runtime.now().toString(36)}-${runtime.randomHex(6)}`;
}
