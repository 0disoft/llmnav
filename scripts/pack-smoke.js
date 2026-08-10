import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), "llmnav-pack-smoke-"));
const packDirectory = path.join(temp, "pack");
const project = path.join(temp, "project");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the packed-install smoke through `npm run smoke:pack`.");

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(path.join(project, "src"), { recursive: true });
  const packedOutput = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packDirectory], root));
  const packed = Array.isArray(packedOutput) ? packedOutput[0] : Object.values(packedOutput)[0];
  const filename = packed?.filename;
  if (!filename) throw new Error(`npm pack did not return a filename: ${JSON.stringify(packedOutput)}`);
  const tarball = path.join(packDirectory, filename);

  await writeFile(path.join(project, "package.json"), `${JSON.stringify({ name: "llmnav-pack-smoke", private: true }, null, 2)}\n`);
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], project);

  const installedPackage = JSON.parse(await readFile(path.join(project, "node_modules", "llmnav", "package.json"), "utf8"));
  if (Object.keys(installedPackage.dependencies ?? {}).length !== 0) {
    throw new Error("The packed package has runtime dependencies.");
  }
  const cli = path.join(project, "node_modules", "llmnav", "bin", "llmnav.js");
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { PACKAGE_VERSION, SEARCH_INDEX_ENCODING, SEARCH_INDEX_SCHEMA_VERSION } from "llmnav";
if (PACKAGE_VERSION !== "0.5.3" || SEARCH_INDEX_SCHEMA_VERSION !== 2 || SEARCH_INDEX_ENCODING !== "compact-v1") process.exit(1);`,
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
if (!result.ok || result.data[0]?.id !== "auth.session.rotate") process.exit(1);`,
    ],
    project,
  );
  const results = JSON.parse(run(process.execPath, [cli, "query", "replayed refresh token", "--root", project, "--json"], project));
  if (results[0]?.id !== "auth.session.rotate") {
    throw new Error(`Installed query returned ${results[0]?.id ?? "no result"}.`);
  }
  run(process.execPath, [cli, "check", "--root", project], project);
  run(process.execPath, [cli, "generate", "--check", "--root", project], project);
  run(process.execPath, [cli, "doctor", "--root", project, "--json"], project);

  console.log(JSON.stringify({
    ok: true,
    package: `${installedPackage.name}@${installedPackage.version}`,
    tarball: filename,
    packageBytes: packed?.size ?? null,
    unpackedBytes: packed?.unpackedSize ?? null,
    runtimeDependencies: 0,
    queryResult: results[0].id,
  }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}
