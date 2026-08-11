import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function verifyReleaseTag({ tag, packageVersion, commit = "HEAD", mainRef = "origin/main", runGit = defaultRunGit }) {
  if (!tag) throw new Error("No release tag supplied. Set GITHUB_REF_NAME or pass a tag argument.");
  if (tag !== `v${packageVersion}`) {
    throw new Error(`Release tag ${tag} does not match package version v${packageVersion}.`);
  }
  const refResult = runGit(["rev-parse", "--verify", `${mainRef}^{commit}`]);
  if (refResult.status !== 0) throw new Error(`Protected release ref ${mainRef} is unavailable.`);
  const lineage = runGit(["merge-base", "--is-ancestor", commit, mainRef]);
  if (lineage.status !== 0) {
    throw new Error(`Release commit ${commit} is not reachable from protected release ref ${mainRef}.`);
  }
}

function defaultRunGit(args) {
  return spawnSync("git", args, { encoding: "utf8", shell: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
  try {
    verifyReleaseTag({
      tag,
      packageVersion: packageJson.version,
      commit: process.env.GITHUB_SHA ?? "HEAD",
      mainRef: process.env.LLMNAV_RELEASE_BRANCH ?? "origin/main",
    });
    console.log(`release tag ${tag} matches package.json and protected main lineage`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
