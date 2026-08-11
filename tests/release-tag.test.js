import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseTag } from "../scripts/verify-tag.js";

test("release tags require matching package version and protected main lineage", () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    return { status: 0, stderr: "" };
  };
  verifyReleaseTag({
    tag: "v0.6.3",
    packageVersion: "0.6.3",
    commit: "release-commit",
    mainRef: "origin/main",
    runGit,
  });
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "origin/main^{commit}"],
    ["merge-base", "--is-ancestor", "release-commit", "origin/main"],
  ]);
});

test("release tags reject commits outside protected main lineage", () => {
  const runGit = (args) => ({
    status: args[0] === "merge-base" ? 1 : 0,
    stderr: "",
  });
  assert.throws(
    () => verifyReleaseTag({
      tag: "v0.6.3",
      packageVersion: "0.6.3",
      commit: "unapproved-commit",
      mainRef: "origin/main",
      runGit,
    }),
    /not reachable from protected release ref origin\/main/u,
  );
});
