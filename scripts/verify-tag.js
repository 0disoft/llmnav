import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag) {
  console.error("No release tag supplied. Set GITHUB_REF_NAME or pass a tag argument.");
  process.exitCode = 1;
} else if (tag !== `v${packageJson.version}`) {
  console.error(`Release tag ${tag} does not match package version v${packageJson.version}.`);
  process.exitCode = 1;
} else {
  console.log(`release tag ${tag} matches package.json`);
}
