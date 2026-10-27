/* llmnav/1 module
id=llmnav.evidence.verification
role=Store caller-reported validation receipts and compare their declared inputs with current files.
owns=verification snapshots|content-addressed receipts|source applicability|evidence links
excludes=test execution|function coverage claims|semantic card validation
search=verification receipts|test evidence source versions|stale validation records
invariant=Execution outcomes and current applicability remain separate and incomplete input coverage yields unknown applicability.
rel=workflow>llmnav.evidence.files
stability=contract
*/

import path from "node:path";
import { mkdir, open } from "node:fs/promises";
import { evidencePath, fingerprintFile } from "./evidence-files.js";
import { atomicWrite, sha256, stableStringify } from "./util.js";
import { mapWithConcurrency } from "./concurrency.js";
import { throwIfAborted } from "./abort.js";

const DIRECTORY = ".llmnav/local/verifications";
const HASH = /^[a-f0-9]{64}$/u;
const environment = () => ({ node: process.version, platform: process.platform, arch: process.arch });
const now = options => new Date((options.now ?? Date.now)()).toISOString();

export async function captureVerificationSnapshot(root, paths, options = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some(file => typeof file !== "string")) throw new TypeError("Snapshot paths require 1 to 1000 explicit files.");
  if (options.completeInputs !== undefined && typeof options.completeInputs !== "boolean") throw new TypeError("completeInputs must be a boolean.");
  const normalized = [];
  for (const file of paths) normalized.push((await evidencePath(root, file)).relative);
  const files = [...new Set(normalized)].sort();
  const hashes = await mapWithConcurrency(files, 8, file => fingerprintFile(root, file, options), { signal: options.signal });
  if (hashes.some(hash => hash === null)) throw new Error("Snapshot inputs must exist before verification.");
  return { schemaVersion: 1, capturedAt: now(options), scope: "explicit-files", completeInputs: options.completeInputs === true,
    sourceHashes: Object.fromEntries(files.map((file, i) => [file, hashes[i]])), environment: environment(), context: context(options.context ?? {}) };
}

export async function recordVerification(root, input, options = {}) {
  validateSnapshot(input?.snapshot);
  if (!Array.isArray(input.command) || !input.command.length || input.command.length > 100 || input.command.some(value => typeof value !== "string" || !value || value.length > 4000 || /\x00/u.test(value))) throw new TypeError("Verification command must be a non-empty argv array.");
  if (!["passed", "failed", "unknown"].includes(input.outcome)) throw new TypeError("Verification outcome must be passed, failed or unknown.");
  const files = input.evidence ?? [];
  if (!Array.isArray(files) || files.length > 32 || files.some(file => typeof file !== "string")) throw new TypeError("Evidence must name at most 32 repository files.");
  const evidence = [];
  for (const file of [...new Set(files)].sort()) {
    const { relative } = await evidencePath(root, file);
    const hash = await fingerprintFile(root, relative, options);
    if (!hash) throw new Error(`Verification evidence is missing: ${relative}`);
    evidence.push({ path: relative, sha256: hash });
  }
  const finishedAt = now(options);
  if (Date.parse(finishedAt) < Date.parse(input.snapshot.capturedAt)) throw new TypeError("Verification completion precedes its snapshot.");
  const receipt = { schemaVersion: 1, provenance: "caller-reported", snapshot: structuredClone(input.snapshot), command: [...input.command],
    outcome: input.outcome, startedAt: input.snapshot.capturedAt, finishedAt, evidence,
    recordingSourceMatch: await sourceMatch(root, input.snapshot.sourceHashes, options) };
  const text = stableStringify(receipt), id = sha256(text), file = `${DIRECTORY}/${id}.json`;
  if (Buffer.byteLength(text) > 1024 * 1024) throw new RangeError("Verification receipt exceeds 1 MiB.");
  const { absolute } = await evidencePath(root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await evidencePath(root, file);
  const existing = await readReceiptText(root, file, options);
  if (existing !== null && existing !== text) throw new Error("Existing verification receipt has been modified.");
  if (existing === null) await atomicWrite(root, absolute, text, options);
  return { id, path: file, receipt };
}

export async function getVerification(root, id, options = {}) {
  if (typeof id !== "string" || !HASH.test(id)) throw new TypeError("Verification ID must be a SHA-256 hash.");
  const budget = options.metadataBudget ?? 4000;
  if (!Number.isSafeInteger(budget) || budget < 512 || budget > 64000) throw new RangeError("Verification metadataBudget must be 512 to 64000 bytes.");
  if (options.details !== undefined && typeof options.details !== "boolean") throw new TypeError("details must be a boolean.");
  const text = await readReceiptText(root, `${DIRECTORY}/${id}.json`, options);
  if (text === null) return { schemaVersion: 1, id, status: "unknown", reason: "receipt-not-found", applicability: "unknown" };
  if (sha256(text) !== id) throw new Error("Verification receipt integrity mismatch.");
  const receipt = JSON.parse(text);
  validateSnapshot(receipt.snapshot);
  if (receipt.schemaVersion !== 1 || receipt.provenance !== "caller-reported" || !["passed", "failed", "unknown"].includes(receipt.outcome) || receipt.startedAt !== receipt.snapshot.capturedAt || typeof receipt.finishedAt !== "string" || receipt.finishedAt.length > 32 || !Number.isFinite(Date.parse(receipt.finishedAt)) || !["matches", "stale"].includes(receipt.recordingSourceMatch) || !Array.isArray(receipt.evidence) || receipt.evidence.length > 32 || receipt.evidence.some(item => typeof item.path !== "string" || !HASH.test(item.sha256))) throw new TypeError("Invalid verification receipt.");
  const sources = await sourceMatch(root, receipt.snapshot.sourceHashes, options);
  const basicEnvironment = stableStringify(environment()) === stableStringify(receipt.snapshot.environment);
  const knownContext = !Object.keys(receipt.snapshot.context).length || options.context !== undefined;
  const environmentMatch = !basicEnvironment ? "stale" : !knownContext ? "unknown" : stableStringify(context(options.context ?? {})) === stableStringify(receipt.snapshot.context) ? "matches" : "stale";
  const evidenceHashes = Object.fromEntries(receipt.evidence.map(item => [item.path, item.sha256]));
  const evidenceMatch = receipt.evidence.length ? await sourceMatch(root, evidenceHashes, options) : "unknown";
  const stale = sources === "stale" || environmentMatch === "stale" || evidenceMatch === "stale" || receipt.recordingSourceMatch === "stale";
  const result = { schemaVersion: 1, id, status: "available", outcome: receipt.outcome, provenance: receipt.provenance,
    startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, scope: receipt.snapshot.scope, sourceCount: Object.keys(receipt.snapshot.sourceHashes).length,
    sourceMatch: sources, environmentMatch, evidenceMatch,
    applicability: stale ? "stale" : receipt.snapshot.completeInputs && environmentMatch === "matches" && evidenceMatch === "matches" ? "matches" : "unknown" };
  if (options.details) {
    const requiredBytes = Buffer.byteLength(JSON.stringify({ ...result, receipt }));
    if (requiredBytes <= budget) result.receipt = receipt;
    else { result.detailsOmitted = true; result.requiredBytes = requiredBytes; }
  }
  return result;
}

async function sourceMatch(root, hashes, options) {
  const files = Object.keys(hashes);
  const current = await mapWithConcurrency(files, 8, file => fingerprintFile(root, file, options), { signal: options.signal });
  return files.every((file, i) => current[i] === hashes[file]) ? "matches" : "stale";
}
function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.scope !== "explicit-files" || typeof snapshot.completeInputs !== "boolean" || typeof snapshot.capturedAt !== "string" || snapshot.capturedAt.length > 32 || !Number.isFinite(Date.parse(snapshot.capturedAt)) || !snapshot.sourceHashes || Array.isArray(snapshot.sourceHashes) || Object.keys(snapshot.sourceHashes).length < 1 || Object.keys(snapshot.sourceHashes).length > 1000 || Object.values(snapshot.sourceHashes).some(hash => typeof hash !== "string" || !HASH.test(hash))) throw new TypeError("Invalid verification snapshot.");
  context(snapshot.environment);
  context(snapshot.context);
}
function context(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32 || Object.entries(value).some(([key, item]) => !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(key) || typeof item !== "string" || item.length > 4000)) throw new TypeError("Verification context requires at most 32 short string fields.");
  return { ...value };
}
async function readReceiptText(root, file, options) {
  throwIfAborted(options.signal);
  const { absolute } = await evidencePath(root, file);
  let handle;
  try { handle = await open(absolute, "r"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const chunks = []; let size = 0;
    for (;;) {
      throwIfAborted(options.signal);
      const chunk = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > 1024 * 1024) throw new RangeError("Verification receipt exceeds 1 MiB.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await handle.close(); }
}

export async function readVerificationManifest(root, file, options = {}) {
  const text = await readReceiptText(root, file, options);
  if (text === null) throw new Error("Verification manifest is missing.");
  return JSON.parse(text);
}
