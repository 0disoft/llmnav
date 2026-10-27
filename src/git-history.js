/* llmnav/1 module
id=llmnav.evidence.history
role=Read file-level Git provenance and current index and worktree state only when requested.
owns=file change commits|staging state|bounded history cache
excludes=function change dates|semantic card validation|repository mutation
search=file git history|last change commit|uncommitted source changes
invariant=Git dates describe files and volatile provenance never enters deterministic navigation artifacts.
rel=workflow>llmnav.evidence.files
stability=contract
*/

import path from "node:path";
import { runCompiler } from "./adapters/process.js";
import { evidencePath, fingerprintFile } from "./evidence-files.js";
import { sha256 } from "./util.js";

const historyCache = new Map();
const CACHE_LIMIT = 128;

export async function getFileHistory(root, file, options = {}) {
  root = path.resolve(root);
  const { relative } = await evidencePath(root, file);
  const git = args => runCompiler(options.gitCommand ?? "git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args], {
    ...options, cwd: root, timeoutMs: options.timeoutMs ?? 10000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  let head;
  try { head = (await git(["rev-parse", "--verify", "-q", "HEAD"])).trim(); }
  catch (error) {
    if (/not a git repository/u.test(error.message)) return { schemaVersion: 1, scope: "file", path: relative, status: "unknown", reason: "not-a-git-repository", head: null, lastChange: null };
    if (error.exitCode !== 1) throw error;
    head = null;
  }
  const staged = await git(["ls-files", "--stage", "-z", "--", relative]);
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", relative]);
  const shallow = (await git(["rev-parse", "--is-shallow-repository"])).trim() === "true";
  const key = JSON.stringify([root, head, relative, shallow]);
  let lastChange = historyCache.get(key);
  if (lastChange === undefined) {
    const log = head ? await git(["log", "-1", "--follow", "--format=%H%x00%cI", head, "--", relative]) : "";
    const [commit, committedAt] = log.trim().split("\0");
    lastChange = commit ? { commit, committedAt, scope: "file" } : null;
    if (historyCache.size >= CACHE_LIMIT) historyCache.delete(historyCache.keys().next().value);
    historyCache.set(key, lastChange);
  }
  const worktreeHash = await fingerprintFile(root, relative, options);
  const code = status.slice(0, 2), untracked = staged === "" && worktreeHash !== null;
  return { schemaVersion: 1, scope: "file", path: relative, status: "available", head, lastChange: lastChange ? { ...lastChange } : null,
    historyComplete: !shallow, consistency: "best-effort", symbolHistory: "unknown",
    dirty: { staged: Boolean(code && code[0] !== " " && code[0] !== "?"), unstaged: Boolean(code && code[1] !== " " && code[1] !== "?"), untracked },
    indexHash: staged ? sha256(staged) : null, worktreeHash };
}
