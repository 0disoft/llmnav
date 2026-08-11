import { access, readFile } from "node:fs/promises";
import { PACKAGE_VERSION } from "../src/spec.js";

const packageRoot = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("package-lock.json", packageRoot), "utf8"));
const issueConfig = await readFile(new URL(".github/ISSUE_TEMPLATE/config.yml", packageRoot), "utf8");
const releaseWorkflow = await readFile(new URL(".github/workflows/release.yml", packageRoot), "utf8");
const serialized = JSON.stringify(packageJson);
const errors = [];

if (packageJson.name !== "llmnav") errors.push("package name must remain llmnav unless the release plan changes");
if (serialized.includes("github.com/OWNER/")) errors.push("replace OWNER in package.json before publishing");
if (issueConfig.includes("github.com/OWNER/")) errors.push("replace OWNER in .github/ISSUE_TEMPLATE/config.yml before publishing");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version)) errors.push("version is not valid semver");
if (packageJson.version !== PACKAGE_VERSION) errors.push(`package.json version ${packageJson.version} does not match src/spec.js ${PACKAGE_VERSION}`);
if (packageLock.name !== packageJson.name || packageLock.version !== packageJson.version) errors.push("package-lock.json name or version is stale");
if (packageJson.publishConfig?.access !== "public") errors.push("publishConfig.access must be public");
if (packageJson.publishConfig?.provenance !== false) errors.push("publishConfig.provenance must be false for a private source repository");
if (!/^\s*contents:\s*write\s*$/mu.test(releaseWorkflow)) errors.push("release workflow must grant contents: write for GitHub Release creation");
if (!/^\s*id-token:\s*write\s*$/mu.test(releaseWorkflow)) errors.push("release workflow must retain id-token: write for npm Trusted Publishing");
if (!/\bgh api\b[\s\S]*\breleases\/tags\//u.test(releaseWorkflow)) errors.push("release workflow must check for an existing GitHub Release by tag");
if (!/\bgh release create\b/u.test(releaseWorkflow)) errors.push("release workflow must create a GitHub Release after npm publication");
if (!/GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/u.test(releaseWorkflow)) errors.push("release workflow must bind GitHub's scoped token explicitly");

try {
  await access(new URL(packageJson.bin.llmnav, packageRoot));
} catch {
  errors.push(`bin target ${packageJson.bin?.llmnav ?? "<missing>"} does not exist`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`release metadata is ready for ${packageJson.name}@${packageJson.version}`);
}
