import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getFileHistory } from "../src/git-history.js";
import { fingerprintFile } from "../src/evidence-files.js";

async function temporary(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-history-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function git(root, ...args) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=.no-hooks", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
test("file history handles unborn repositories, same-HEAD changes, staging, renames and deletion", async context => {
  const root = await temporary(context);
  git(root, "init", "-q");
  const file = "한글[1].ts";
  await writeFile(path.join(root, file), "one\n");
  const unborn = await getFileHistory(root, file);
  assert.equal(unborn.head, null);
  assert.equal(unborn.lastChange, null);
  assert.equal(unborn.dirty.untracked, true);
  git(root, "add", "."); git(root, "commit", "-qm", "first");
  const committed = await getFileHistory(root, file);
  assert.equal(committed.lastChange.commit, git(root, "rev-parse", "HEAD"));
  assert.deepEqual(committed.dirty, { staged: false, unstaged: false, untracked: false });
  await writeFile(path.join(root, file), "two\n");
  const edited = await getFileHistory(root, file);
  assert.equal(edited.head, committed.head);
  assert.equal(edited.dirty.unstaged, true);
  assert.notEqual(edited.worktreeHash, committed.worktreeHash);
  git(root, "add", ".");
  const staged = await getFileHistory(root, file);
  assert.equal(staged.dirty.staged, true);
  assert.notEqual(staged.indexHash, committed.indexHash);
  assert.equal(staged.dirty.unstaged, false);
  git(root, "commit", "-qm", "second");
  git(root, "mv", file, "renamed.ts"); git(root, "commit", "-qm", "rename");
  assert.equal((await getFileHistory(root, "renamed.ts")).lastChange.commit, git(root, "rev-parse", "HEAD"));
  await rm(path.join(root, "renamed.ts"));
  assert.equal((await getFileHistory(root, "renamed.ts")).worktreeHash, null);
});
test("non-Git history is unknown and file evidence rejects escapes, symlinks and cancellation", async context => {
  const root = await temporary(context);
  await writeFile(path.join(root, "a.ts"), "ok");
  assert.equal((await getFileHistory(root, "a.ts")).reason, "not-a-git-repository");
  await assert.rejects(getFileHistory(root, "../outside"), /relative|inside/u);
  const controller = new AbortController(); controller.abort(new Error("cancel evidence"));
  await assert.rejects(fingerprintFile(root, "a.ts", { signal: controller.signal }), /cancel evidence/u);
  const outside = await temporary(context);
  await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(fingerprintFile(root, "linked/file"), /symbolic link|junction/u);
});
