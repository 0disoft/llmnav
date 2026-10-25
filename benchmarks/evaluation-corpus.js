import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyCorpus } from "./real-navigation.js";

export async function prepareCorpus(original, target, entry) {
  const sources = await copyCorpus(original, target, entry);
  await mkdir(path.join(target, ".serena"), { recursive: true });
  await mkdir(path.join(target, ".llmnav"), { recursive: true });
  await writeFile(path.join(target, ".serena/project.yml"), `project_name: pilot\nlanguages: [${entry.language}]\n`);
  await writeFile(path.join(target, ".llmnav/config.json"), JSON.stringify({ repositoryId: entry.id, sourceRoots: entry.sourceRoots }));
  if (entry.language === "go") {
    // The source provenance, including the actual Go version, is recorded separately.
    await writeFile(path.join(target, "go.mod"), "module llmnav-pilot/token\n\ngo 1.26.0\n");
  } else {
    await writeFile(path.join(target, "package.json"), '{"private":true,"type":"commonjs"}\n');
    await writeFile(path.join(target, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: true, types: [],
      rootDir: ".", outDir: "out",
    }, include: ["src/**/*.ts"] }));
  }
  return sources;
}
