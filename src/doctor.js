import path from "node:path";
import { loadConfig } from "./config.js";
import { generateProject } from "./generator.js";
import { usableFileState } from "./incremental.js";
import { verifySearchIndex } from "./inverted-index.js";
import { recoverGenerationTransaction } from "./transaction.js";
import { readJson, readJsonSafe, readText, sha256 } from "./util.js";

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

  try {
    const recovery = await recoverGenerationTransaction(root, {
      cacheDirectory: config.generation.cacheDirectory,
    });
    checks.push(
      recovery.recovered
        ? pass("transaction", `recovered interrupted generation using ${recovery.action}`)
        : pass("transaction", "no interrupted generation is pending"),
    );
  } catch (error) {
    checks.push(fail("transaction", error instanceof Error ? error.message : String(error)));
  }

  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push(major >= 22 ? pass("node", `Node.js ${process.versions.node}`) : fail("node", "Node.js 22 or newer is required"));

  for (const [name, relativePath] of [
    ["agent", ".llmnav/AGENT_INSTRUCTIONS.md"],
    ["registry", ".llmnav/ids.jsonl"],
    ["order", ".llmnav/order.lock"],
    ["lexicon", ".llmnav/lexicon.json"],
    ["index", `${config.generation.cacheDirectory}/index.json`],
    ["search-index", `${config.generation.cacheDirectory}/search-index.json`],
    ["file-state", `${config.generation.cacheDirectory}/file-state.json`],
  ]) {
    const exists = (await readText(path.join(root, relativePath), null)) !== null;
    checks.push(exists ? pass(name, `${relativePath} exists`) : fail(name, `${relativePath} is missing`));
  }

  const cacheRoot = path.join(root, config.generation.cacheDirectory);
  const indexRead = await inspectJson(path.join(cacheRoot, "index.json"));
  const searchRead = await inspectJson(path.join(cacheRoot, "search-index.json"));
  const fileStateRead = await inspectJson(path.join(cacheRoot, "file-state.json"));
  const index = indexRead.value;
  const searchIndex = searchRead.value;
  const fileState = fileStateRead.value;
  if (indexRead.error) checks.push(fail("index-integrity", indexRead.error));
  if (searchRead.error) checks.push(fail("search-index-integrity", searchRead.error));
  else if (index && searchIndex) {
    checks.push(
      verifySearchIndex(index, searchIndex)
        ? pass("search-index-integrity", "search-index.json matches index.json")
        : fail("search-index-integrity", "search-index.json does not match index.json"),
    );
  }
  if (fileStateRead.error) checks.push(fail("file-state-integrity", fileStateRead.error));
  else if (fileState) {
    checks.push(
      usableFileState(fileState)
        ? pass("file-state-integrity", "file-state.json uses the supported schema")
        : fail("file-state-integrity", "file-state.json uses an unsupported or malformed schema"),
    );
  }

  const manifestPath = path.join(cacheRoot, "manifest.json");
  const manifestRead = await inspectJson(manifestPath);
  const manifest = manifestRead.value;
  if (manifestRead.error) checks.push(fail("manifest", manifestRead.error));
  if (!manifest && !manifestRead.error) {
    checks.push(fail("manifest", `${config.generation.cacheDirectory}/manifest.json is missing`));
  } else if (manifest) {
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

  const packageJson = await readJsonSafe(path.join(root, "package.json"), null);
  if (packageJson?.name === "llmnav" && JSON.stringify(packageJson).includes("github.com/OWNER/")) {
    checks.push(fail("release", "replace OWNER in package.json before publishing"));
  }

  return { ok: checks.every((check) => check.ok), checks };
}

async function inspectJson(filePath) {
  try {
    return { value: await readJson(filePath, null), error: null };
  } catch (error) {
    return {
      value: null,
      error: `${path.basename(filePath)} is malformed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function pass(name, message) {
  return { name, ok: true, message };
}

function fail(name, message) {
  return { name, ok: false, message };
}
