import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the packed-install smoke through `npm run smoke:pack`.");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !/^--published=\d+\.\d+\.\d+$/u.test(args[0]))) {
  throw new Error("Expected no arguments or --published=X.Y.Z.");
}
const publishedVersion = args[0]?.slice("--published=".length) ?? null;
const temp = await mkdtemp(path.join(os.tmpdir(), "llmnav-pack-smoke-"));
const packDirectory = path.join(temp, "pack");
const project = path.join(temp, "project");

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(path.join(project, "src"), { recursive: true });
  let installSource = publishedVersion ? `llmnav@${publishedVersion}` : null;
  let packed = null;
  let filename = null;
  if (!installSource) {
    const packedOutput = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packDirectory], root));
    packed = Array.isArray(packedOutput) ? packedOutput[0] : Object.values(packedOutput)[0];
    filename = packed?.filename;
    if (!filename) throw new Error(`npm pack did not return a filename: ${JSON.stringify(packedOutput)}`);
    installSource = path.join(packDirectory, filename);
  }

  await writeFile(path.join(project, "package.json"), `${JSON.stringify({ name: "llmnav-pack-smoke", private: true }, null, 2)}\n`);
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", installSource], project);

  const installedPackage = JSON.parse(await readFile(path.join(project, "node_modules", "llmnav", "package.json"), "utf8"));
  if (publishedVersion && installedPackage.version !== publishedVersion) throw new Error("Installed version does not match the requested publication.");
  if (Object.keys(installedPackage.dependencies ?? {}).length !== 0) {
    throw new Error("The packed package has runtime dependencies.");
  }
  const cli = path.join(project, "node_modules", "llmnav", "bin", "llmnav.js");
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { PACKAGE_VERSION, SEARCH_INDEX_ENCODING, SEARCH_INDEX_SCHEMA_VERSION, explainProjectFile } from "llmnav";
if (PACKAGE_VERSION !== ${JSON.stringify(installedPackage.version)} || SEARCH_INDEX_SCHEMA_VERSION !== 2 || SEARCH_INDEX_ENCODING !== "compact-v1" || typeof explainProjectFile !== "function") process.exit(1);`,
    ],
    project,
  );
  await writeFile(
    path.join(project, "src", "rotate.ts"),
    `/* llmnav/1 symbol\nid=auth.session.rotate\nrole=Rotate one refresh-token family and reject replayed tokens.\nsearch=refresh token|token rotation|replay detection\ninvariant=At most one live refresh token exists per family.\nstability=contract\n*/\nexport function rotateSession(): void {}\n`,
  );

  run(process.execPath, [cli, "init", "--agents", "none", "--root", project], project);
  const generation = JSON.parse(run(process.execPath, [cli, "generate", "--root", project, "--json"], project));
  if (!generation.ok) throw new Error(`Installed generation failed: ${JSON.stringify(generation)}`);
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { createLlmnavHost } from "llmnav/examples/provider-neutral-host.mjs";
const host = await createLlmnavHost(process.cwd());
const result = await host.execute({ name: "llmnav_query", input: { task: "replayed refresh token" } });
const explanation = await host.execute({ name: "llmnav_explain", input: { file: "src/rotate.ts" } });
const shown = await host.execute({ name: "llmnav_show", input: { id: "auth.session.rotate" } });
const context = await host.execute({ name: "llmnav_context", input: { id: "auth.session.rotate", maxEdges: 0 } });
await host.refresh();
const refreshed = await host.execute({ name: "llmnav_query", input: { task: "replayed refresh token" } });
if (!result.ok || result.data[0]?.id !== "auth.session.rotate" || !explanation.ok || explanation.data.status !== "candidate" || !shown.ok || shown.data.card?.id !== "auth.session.rotate" || !context.ok || context.data.included.length !== 1 || !refreshed.ok || refreshed.data[0]?.id !== "auth.session.rotate") process.exit(1);`,
    ],
    project,
  );
  const results = JSON.parse(run(process.execPath, [cli, "query", "replayed refresh token", "--root", project, "--json"], project));
  if (results[0]?.id !== "auth.session.rotate") {
    throw new Error(`Installed query returned ${results[0]?.id ?? "no result"}.`);
  }
  const explanation = JSON.parse(run(process.execPath, [cli, "explain", "src/rotate.ts", "--root", project, "--json"], project));
  if (explanation.status !== "candidate" || explanation.candidate?.priority !== "low" || explanation.navigationCards[0]?.id !== "auth.session.rotate") {
    throw new Error(`Installed explain returned an unexpected result: ${JSON.stringify(explanation)}`);
  }
  run(process.execPath, [cli, "check", "--root", project], project);
  run(process.execPath, [cli, "generate", "--check", "--root", project], project);
  const fileStatePath = path.join(project, ".llmnav", "cache", "file-state.json");
  const fileState = JSON.parse(await readFile(fileStatePath, "utf8"));
  fileState.indexerVersion -= 1;
  await writeFile(fileStatePath, `${JSON.stringify(fileState, null, 2)}\n`);
  const migrationCheck = runStatus(process.execPath, [cli, "migrate", "--check", "--root", project, "--json"], project);
  if (migrationCheck.status !== 1 || JSON.parse(migrationCheck.stdout).required !== true) {
    throw new Error(`Installed migration check did not report the stale file state: ${migrationCheck.stdout}${migrationCheck.stderr}`);
  }
  const migration = JSON.parse(run(process.execPath, [cli, "migrate", "--write", "--root", project, "--json"], project));
  if (!migration.ok || !migration.applied) throw new Error(`Installed migration failed: ${JSON.stringify(migration)}`);
  run(process.execPath, [cli, "migrate", "--check", "--root", project], project);
  run(process.execPath, [cli, "doctor", "--root", project, "--json"], project);

  console.log(JSON.stringify({
    ok: true,
    package: `${installedPackage.name}@${installedPackage.version}`,
    source: publishedVersion ? "npm-registry" : "local-tarball",
    tarball: filename,
    packageBytes: packed?.size ?? null,
    unpackedBytes: packed?.unpackedSize ?? null,
    runtimeDependencies: 0,
    queryResult: results[0].id,
    explainStatus: explanation.status,
  }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}

function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, npm_config_update_notifier: "false" },
  });
}

function runNpm(args, cwd) {
  // npm run can export .npmrc policy as an environment override, which newer
  // npm rejects for project installs. The install still uses --ignore-scripts.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"));
  return run(process.execPath, [npmCli, ...args], cwd, env);
}

function runStatus(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
