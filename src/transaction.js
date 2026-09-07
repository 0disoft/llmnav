/* llmnav/1 module
id=llmnav.index.transaction
role=Commit a complete generated cache with rollback and crash recovery across POSIX and Windows rename behavior.
owns=cache staging|directory swap|generation recovery
excludes=artifact semantics|source indexing
search=transactional generation|atomic cache swap|Windows rename recovery
rel=workflow>llmnav.index.generate
stability=architecture
*/

import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

export const TRANSACTION_SCHEMA_VERSION = 1;
export const TRANSACTION_ABORT_EXIT_CODE = 86;
const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]);
const DEFAULT_RETRY_DELAYS = Object.freeze([0, 8, 16, 32, 64, 128, 256, 512]);
const JOURNAL_PHASES = new Set(["prepared", "old-moved", "new-installed", "committed"]);
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 50;
const CONTROL_ARTIFACT_PATHS = new Set([".llmnav/ids.jsonl", ".llmnav/order.lock"]);

export async function withGenerationLock(root, callback, options = {}) {
  const lock = await acquireGenerationLock(root, options);
  try {
    return await callback(lock);
  } finally {
    await releaseGenerationLock(lock);
  }
}

export async function acquireGenerationLock(root, options = {}) {
  const controlDirectory = path.join(root, ".llmnav");
  const lockPath = path.join(controlDirectory, "generation.lock");
  await assertNoSymlinkTraversal(root, controlDirectory, ".llmnav");
  await assertNoSymlinkTraversal(root, lockPath, ".llmnav/generation.lock");
  await mkdir(controlDirectory, { recursive: true });
  const ownerId = options.ownerId ?? createTransactionId();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const delays = options.delays ?? [0, ...Array.from({ length: Math.ceil(timeoutMs / pollMs) }, () => pollMs)];
  const openImpl = options.openImpl ?? open;
  const sleepImpl = options.sleepImpl ?? sleep;
  const candidatePath = `${lockPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  // Publish only a closed, complete owner record. A crash before publication
  // leaves an unused candidate, never an unreadable authoritative lock.
  let candidateCreated = false;
  try {
    const handle = await openImpl(candidatePath, "wx");
    candidateCreated = true;
    try {
      await handle.writeFile(stableStringify({ schemaVersion: 1, ownerId, pid: process.pid }));
      await handle.sync();
    } finally {
      await handle.close();
    }

    for (const delay of delays) {
      if (delay > 0) await sleepImpl(delay);
      try {
        await link(candidatePath, lockPath);
        return { root, lockPath, ownerId };
      } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
        const existing = await readJsonSafe(lockPath, null);
        if (existing && Number.isInteger(existing.pid) && !isProcessAlive(existing.pid)) {
          await removeOwnedLock(lockPath, existing.ownerId);
        }
      }
    }
    const existing = await readJsonSafe(lockPath, null);
    if (!existing || !Number.isInteger(existing.pid) || !existing.ownerId) {
      throw new Error("The LLMNav generation lock has no valid owner record. After stopping all LLMNav processes, remove .llmnav/generation.lock and retry.");
    }
    throw new Error("Timed out waiting for the LLMNav generation lock.");
  } finally {
    // Candidate cleanup must not turn successful acquisition into a leaked lock.
    if (candidateCreated) await removeWithRetry(candidatePath).catch(() => {});
  }
}

export async function releaseGenerationLock(lock) {
  await removeOwnedLock(lock.lockPath, lock.ownerId);
}

export async function commitGeneratedCache(root, cacheDirectory, artifacts, options = {}) {
  if (!options.lockOwnerId) {
    return withGenerationLock(
      root,
      (lock) => commitGeneratedCache(root, cacheDirectory, artifacts, { ...options, lockOwnerId: lock.ownerId }),
      options.lockOptions,
    );
  }
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

  const transactionId = options.transactionId ?? createTransactionId();
  const transactionPath = path.join(transactionsDirectory, transactionId);
  const stagePath = path.join(transactionPath, "stage");
  const backupPath = path.join(transactionPath, "backup");
  await assertNoSymlinkTraversal(root, transactionPath, relativePosix(root, transactionPath));
  const hadExistingCacheAtStart = await pathExists(cachePath);
  let controlRecords = [];
  await mkdir(stagePath, { recursive: true });

  const cachePrefix = `${cacheRelative.replace(/\/+$/u, "")}/`;
  const cacheArtifacts = [...artifacts.entries()]
    .filter(([relativePath]) => toPosix(relativePath).startsWith(cachePrefix))
    .sort(([left], [right]) => compareText(toPosix(left), toPosix(right)));
  if (cacheArtifacts.length === 0) throw new Error(`No generated artifacts target ${cacheRelative}.`);

  try {
    for (const [relativePath, content] of cacheArtifacts) {
      const normalized = projectRelativePath(relativePath, `Generated artifact ${relativePath}`);
      const stageRelative = normalized.slice(cachePrefix.length);
      if (!normalized.startsWith(cachePrefix) || !stageRelative) {
        throw new Error(`Generated artifact ${normalized} escapes the staged cache.`);
      }
      const destination = path.join(stagePath, ...stageRelative.split("/"));
      const relativeDestination = path.relative(stagePath, path.resolve(destination));
      if (relativeDestination === ".." || relativeDestination.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDestination)) {
        throw new Error(`Generated artifact ${normalized} escapes the staged cache.`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
      await invokeFailpoint(`after-write:${stageRelative}`, options);
    }
    await verifyStagedArtifacts(stagePath, cacheArtifacts, cachePrefix);
    controlRecords = await stageControlArtifacts(root, transactionPath, options.controlArtifacts);
    await invokeFailpoint("after-stage", options);

    const hadExistingCache = hadExistingCacheAtStart;
    let journal = {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      cacheDirectory: cacheRelative,
      transactionDirectory: relativePosix(root, transactionPath),
      stageDirectory: relativePosix(root, stagePath),
      backupDirectory: relativePosix(root, backupPath),
      hadExistingCache,
      ownerId: options.lockOwnerId,
      controlArtifacts: controlRecords,
      phase: "prepared",
    };
    await atomicWrite(root, journalPath, stableStringify(journal));
    await invokeFailpoint("after-journal", options);

    if (hadExistingCache) {
      await renameWithRetry(cachePath, backupPath, options.renameOptions);
    }
    await moveControlArtifactsToBackup(root, controlRecords, options.renameOptions);
    journal = { ...journal, phase: "old-moved" };
    await atomicWrite(root, journalPath, stableStringify(journal));
    await invokeFailpoint("after-cache-moved", options);

    await renameWithRetry(stagePath, cachePath, options.renameOptions);
    await installControlArtifacts(root, controlRecords, options.renameOptions);
    journal = { ...journal, phase: "new-installed" };
    await atomicWrite(root, journalPath, stableStringify(journal));
    await verifyCommittedCache(cachePath, cacheRelative);
    await verifyControlArtifacts(root, controlRecords);
    await invokeFailpoint("after-new-installed", options);

    journal = { ...journal, phase: "committed" };
    await atomicWrite(root, journalPath, stableStringify(journal));
    if (hadExistingCache) await removeWithRetry(backupPath, options.renameOptions);
    await removeWithRetry(transactionPath, options.renameOptions);
    await removeWithRetry(journalPath, options.renameOptions);
    await cleanupEmptyTransactionsDirectory(transactionsDirectory);

    return {
      committed: true,
      skipped: false,
      recovered: recovery.recovered,
      recoveryAction: recovery.action,
      transactionId,
      replacedExisting: hadExistingCache,
    };
  } catch (error) {
    const journal = await readJson(journalPath, null);
    const ownedJournal = journal?.ownerId === options.lockOwnerId ? journal : null;
    if (ownedJournal?.phase !== "committed") {
      try {
        await rollbackTransaction(root, ownedJournal ?? {
          schemaVersion: TRANSACTION_SCHEMA_VERSION,
          cacheDirectory: cacheRelative,
          transactionDirectory: relativePosix(root, transactionPath),
          stageDirectory: relativePosix(root, stagePath),
          backupDirectory: relativePosix(root, backupPath),
          hadExistingCache: hadExistingCacheAtStart,
          ownerId: options.lockOwnerId,
          controlArtifacts: controlRecords,
          phase: "prepared",
        }, cacheRelative, options.renameOptions);
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new AggregateError([error, rollbackError], `Generation failed and rollback also failed: ${message}`);
      }
    }
    throw error;
  }
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

async function removeOwnedLock(lockPath, ownerId) {
  const quarantinePath = `${lockPath}.release-${ownerId}-${randomBytes(4).toString("hex")}`;
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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}

async function invokeFailpoint(name, options) {
  if (typeof options.onPhase === "function") await options.onPhase(name);
  const failpoint = options.failpoint ?? process.env.LLMNAV_TEST_FAILPOINT;
  if (failpoint === `throw:${name}`) throw new Error(`Injected generation failure at ${name}.`);
  if (failpoint === `abort:${name}`) process.exit(TRANSACTION_ABORT_EXIT_CODE);
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

function createTransactionId() {
  return `${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}
