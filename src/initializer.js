/* llmnav/1 module
id=llmnav.project.initialize
role=Create a repository's LLMNav configuration, registry, schemas, agent instructions, and initial index.
owns=project bootstrap|configuration templates|initial generation
excludes=package installation|automatic annotation
search=llmnav init|repository bootstrap|agent setup
rel=workflow>llmnav.agent.install
rel=workflow>llmnav.index.generate
stability=architecture
*/

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installAgentInstructions } from "./agents.js";
import { generateProject } from "./generator.js";
import { DEFAULT_CONFIG } from "./spec.js";
import { assertNoSymlinkTraversal, atomicWrite, readJson, readText, stableStringify } from "./util.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function initializeProject(root, options = {}) {
  await assertNoSymlinkTraversal(root, path.join(root, ".llmnav"), ".llmnav");
  await mkdir(path.join(root, ".llmnav", "eval"), { recursive: true });
  await mkdir(path.join(root, ".llmnav", "schema"), { recursive: true });
  const repositoryId = await inferRepositoryId(root);
  const changed = [];

  const config = structuredClone(DEFAULT_CONFIG);
  config.repositoryId = repositoryId;
  config.$schema = "./schema/config.schema.json";
  await writeIfMissingOrForced(
    path.join(root, ".llmnav", "config.json"),
    stableStringify(config),
    options.force,
    changed,
    ".llmnav/config.json",
  );

  await writeIfMissingOrForced(
    path.join(root, ".llmnav", "lexicon.json"),
    stableStringify({ version: 1, aliases: {} }),
    false,
    changed,
    ".llmnav/lexicon.json",
  );
  await writeIfMissingOrForced(
    path.join(root, ".llmnav", "ids.jsonl"),
    "",
    false,
    changed,
    ".llmnav/ids.jsonl",
  );
  await writeIfMissingOrForced(
    path.join(root, ".llmnav", "order.lock"),
    "",
    false,
    changed,
    ".llmnav/order.lock",
  );
  await writeIfMissingOrForced(
    path.join(root, ".llmnav", "eval", "queries.jsonl"),
    '# One JSON object per line: {"query":"...","expected":["domain.feature.action"]}\n',
    false,
    changed,
    ".llmnav/eval/queries.jsonl",
  );
  await writeIfMissingOrForced(
    path.join(root, ".llmnav", ".gitignore"),
    "tmp/\n*.tmp-*\n",
    options.force,
    changed,
    ".llmnav/.gitignore",
  );

  const schemaSource = path.join(PACKAGE_ROOT, "schema", "config.schema.json");
  const schemaTarget = path.join(root, ".llmnav", "schema", "config.schema.json");
  if (options.force || (await readText(schemaTarget, null)) === null) {
    await copyFile(schemaSource, schemaTarget);
    changed.push(".llmnav/schema/config.schema.json");
  }

  changed.push(...(await installAgentInstructions(root, options.agents ?? ["agents"])));

  if (options.packageScripts) {
    if (await addPackageScripts(root)) changed.push("package.json");
  }

  const generated = await generateProject(root, { check: false });
  if (!generated.ok) {
    return { ok: false, changed: [...new Set(changed)].sort(), generated };
  }
  changed.push(...generated.changedFiles);
  return { ok: true, changed: [...new Set(changed)].sort(), generated };
}

async function inferRepositoryId(root) {
  const packageJson = await readJson(path.join(root, "package.json"), null);
  const candidate = packageJson?.name ?? path.basename(root);
  const normalized = String(candidate)
    .replace(/^@[^/]+\//u, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "repository";
}

async function writeIfMissingOrForced(filePath, content, force, changed, displayPath) {
  const existing = await readText(filePath, null);
  if (existing !== null && !force) return;
  if (existing === content) return;
  await atomicWrite(filePath, content);
  changed.push(displayPath);
}

async function addPackageScripts(root) {
  const packagePath = path.join(root, "package.json");
  const text = await readText(packagePath, null);
  if (text === null) return false;
  const parsed = JSON.parse(text);
  parsed.scripts ??= {};
  const desired = {
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
  if (changed) await atomicWrite(packagePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return changed;
}
