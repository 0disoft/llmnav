import path from "node:path";
import { loadConfig } from "./config.js";
import { generateProject } from "./generator.js";
import { readJson, readText, sha256 } from "./util.js";

export async function doctorProject(root) {
  const checks = [];
  let config;
  try {
    ({ config } = await loadConfig(root));
    checks.push(pass("config", ".llmnav/config.json is valid"));
  } catch (error) {
    checks.push(fail("config", error instanceof Error ? error.message : String(error)));
    return { ok: false, checks };
  }

  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push(major >= 22 ? pass("node", `Node.js ${process.versions.node}`) : fail("node", "Node.js 22 or newer is required"));

  for (const [name, relativePath] of [
    ["agent", ".llmnav/AGENT_INSTRUCTIONS.md"],
    ["registry", ".llmnav/ids.jsonl"],
    ["order", ".llmnav/order.lock"],
    ["lexicon", ".llmnav/lexicon.json"],
    ["index", `${config.generation.cacheDirectory}/index.json`],
  ]) {
    const exists = (await readText(path.join(root, relativePath), null)) !== null;
    checks.push(exists ? pass(name, `${relativePath} exists`) : fail(name, `${relativePath} is missing`));
  }

  const manifestPath = path.join(root, config.generation.cacheDirectory, "manifest.json");
  const manifest = await readJson(manifestPath, null);
  if (!manifest) {
    checks.push(fail("manifest", `${config.generation.cacheDirectory}/manifest.json is missing`));
  } else {
    let valid = true;
    for (const [relativePath, expectedHash] of Object.entries(manifest.files ?? {})) {
      const content = await readText(path.join(root, relativePath), null);
      if (content === null || sha256(content) !== expectedHash) {
        valid = false;
        checks.push(fail("manifest", `${relativePath} does not match its manifest hash`));
      }
    }
    if (valid) checks.push(pass("manifest", "generated cache hashes are valid"));
  }

  const generated = await generateProject(root, { check: true });
  checks.push(
    generated.ok
      ? pass("generated", "generated files are current")
      : fail("generated", `regenerate ${generated.changedFiles.join(", ") || "after fixing diagnostics"}`),
  );

  const packageJson = await readJson(path.join(root, "package.json"), null);
  if (packageJson?.name === "llmnav" && JSON.stringify(packageJson).includes("github.com/OWNER/")) {
    checks.push(fail("release", "replace OWNER in package.json before publishing"));
  }

  return { ok: checks.every((check) => check.ok), checks };
}

function pass(name, message) {
  return { name, ok: true, message };
}

function fail(name, message) {
  return { name, ok: false, message };
}
