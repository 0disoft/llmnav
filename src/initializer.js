/* llmnav/1 module
id=llmnav.project.initialize
role=Create a repository's LLMNav configuration, registry, schemas, agent instructions, and initial index.
owns=project bootstrap|configuration templates|initial generation
excludes=package installation|automatic annotation
search=llmnav init|repository bootstrap|agent setup
invariant=Bootstrap writes and index generation share one repository lock.
rel=workflow>llmnav.agent.install
rel=workflow>llmnav.index.generate
stability=architecture
*/

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installAgentInstructions, normalizeAgentAdapters, validateAgentInstructions } from "./agents.js";
import { generateProjectWithPreparation } from "./generator.js";
import { DEFAULT_CONFIG } from "./spec.js";
import { assertNoSymlinkTraversal, atomicWrite, readText, sha256, stableStringify } from "./util.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function initializeProject(root, options = {}) {
  const agents = normalizeAgentAdapters(options.agents ?? ["agents"]);
  // Reject malformed inputs before lock acquisition creates the control directory.
  await readPackageManifest(root, options.packageScripts);
  await validateAgentInstructions(root, agents);
  let changed;
  const generated = await generateProjectWithPreparation(root, async () => {
    changed = await bootstrapProject(root, options, agents);
  }, { check: false });
  if (!generated.ok) return { ok: false, changed: [...new Set(changed)].sort(), generated };
  changed.push(...generated.changedFiles);
  return { ok: true, changed: [...new Set(changed)].sort(), generated };
}

async function bootstrapProject(root, options, agents) {
  // Inputs may have changed while another operation owned the lock.
  const packageJson = await readPackageManifest(root, options.packageScripts);
  const repositoryId = inferRepositoryId(root, packageJson);
  await validateAgentInstructions(root, agents);
  const controlDirectory = path.join(root, ".llmnav");
  const evalDirectory = path.join(controlDirectory, "eval");
  const schemaDirectory = path.join(controlDirectory, "schema");
  await assertNoSymlinkTraversal(root, controlDirectory, ".llmnav");
  await assertNoSymlinkTraversal(root, evalDirectory, ".llmnav/eval");
  await assertNoSymlinkTraversal(root, schemaDirectory, ".llmnav/schema");
  await mkdir(evalDirectory, { recursive: true });
  await mkdir(schemaDirectory, { recursive: true });
  const changed = [];

  const config = structuredClone(DEFAULT_CONFIG);
  config.repositoryId = repositoryId;
  config.$schema = "./schema/config.schema.json";
  await writeIfMissingOrForced(
    root,
    path.join(root, ".llmnav", "config.json"),
    stableStringify(config),
    options.force,
    changed,
    ".llmnav/config.json",
  );

  await writeIfMissingOrForced(
    root,
    path.join(root, ".llmnav", "lexicon.json"),
    stableStringify({ version: 1, aliases: {} }),
    false,
    changed,
    ".llmnav/lexicon.json",
  );
  await writeIfMissingOrForced(
    root,
    path.join(root, ".llmnav", "ids.jsonl"),
    "",
    false,
    changed,
    ".llmnav/ids.jsonl",
  );
  await writeIfMissingOrForced(
    root,
    path.join(root, ".llmnav", "order.lock"),
    "",
    false,
    changed,
    ".llmnav/order.lock",
  );
  await writeIfMissingOrForced(
    root,
    path.join(root, ".llmnav", "eval", "queries.jsonl"),
    '# One JSON object per line: {"query":"...","expected":["domain.feature.action"]}\n',
    false,
    changed,
    ".llmnav/eval/queries.jsonl",
  );
  await writeIfMissingOrForced(
    root,
    path.join(root, ".llmnav", ".gitignore"),
    "tmp/\nstate/\n.transactions/\ngeneration-transaction.json\ngeneration.lock\ngeneration.lock.guard\ngeneration.lock.release-*\n*.tmp-*\n",
    options.force,
    changed,
    ".llmnav/.gitignore",
  );

  const schemaSource = path.join(PACKAGE_ROOT, "schema", "config.schema.json");
  const schemaTarget = path.join(root, ".llmnav", "schema", "config.schema.json");
  await assertNoSymlinkTraversal(root, schemaTarget, ".llmnav/schema/config.schema.json");
  if (options.force || (await readText(schemaTarget, null)) === null) {
    await copyFile(schemaSource, schemaTarget);
    changed.push(".llmnav/schema/config.schema.json");
  }

  changed.push(...(await installAgentInstructions(root, agents)));

  if (options.packageScripts) {
    if (await addPackageScripts(root)) changed.push("package.json");
  }

  return changed;
}

function inferRepositoryId(root, packageJson) {
  const candidate = packageJson?.name ?? path.basename(root);
  const normalized = String(candidate)
    .replace(/^@[^/]+\//u, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!normalized) return "repository";
  const identifier = /^[a-z]/u.test(normalized) ? normalized : `repository-${normalized}`;
  if (identifier.length <= 64) return identifier;
  return `${identifier.slice(0, 51)}-${sha256(identifier).slice(0, 12)}`;
}

async function readPackageManifest(root, validateScripts) {
  const packagePath = path.join(root, "package.json");
  await assertNoSymlinkTraversal(root, packagePath, "package.json");
  const text = await readText(packagePath, null);
  if (text === null) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    throw packageUsageError("package.json must contain a valid JSON object. Correct it and rerun llmnav init.", error);
  }
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(parsed)) throw packageUsageError("package.json must contain a JSON object. Correct it and rerun llmnav init.");
  if (validateScripts && parsed.scripts != null && !object(parsed.scripts)) {
    throw packageUsageError("package.json scripts must be an object before using --package-scripts. Correct it and rerun llmnav init.");
  }
  return parsed;
}

function packageUsageError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.exitCode = 2;
  return error;
}

async function writeIfMissingOrForced(root, filePath, content, force, changed, displayPath) {
  await assertNoSymlinkTraversal(root, filePath, displayPath);
  const existing = await readText(filePath, null);
  if (existing !== null && !force) return;
  if (existing === content) return;
  await atomicWrite(root, filePath, content);
  changed.push(displayPath);
}

async function addPackageScripts(root) {
  const packagePath = path.join(root, "package.json");
  const parsed = await readPackageManifest(root, true);
  if (parsed === null) return false;
  parsed.scripts ??= {};
  const desired = {
    "llmnav:audit": "llmnav audit --fail-on high",
    "llmnav:check": "llmnav check",
    "llmnav:format": "llmnav format",
    "llmnav:generate": "llmnav generate",
    "llmnav:eval": "llmnav eval",
  };
  let changed = false;
  for (const [name, command] of Object.entries(desired)) {
    if (parsed.scripts[name] === command) continue;
    parsed.scripts[name] = command;
    changed = true;
  }
  if (changed) await atomicWrite(root, packagePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return changed;
}
