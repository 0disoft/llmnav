/* llmnav/1 module
id=llmnav.structure.modules
role=Resolve repository-contained language modules without executing project toolchains or following metadata symlinks.
owns=language module identity|Go module discovery|Go package import resolution
excludes=dependency installation|external module lookup|semantic card generation
search=Go module import|package boundary|local module resolution
invariant=Module resolution reads only regular repository-contained metadata files and never executes a language toolchain.
rel=workflow>llmnav.project.scan
rel=workflow>llmnav.graph.generate
stability=architecture
*/

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { compareText, toPosix } from "./util.js";

export const MODULE_RESOLUTION_SCHEMA_VERSION = 1;
export const MODULE_RESOLVER_VERSION = 1;

export async function loadModuleResolution(root, fileRecords = []) {
  const directories = new Set([""]);
  for (const record of fileRecords) {
    const file = toPosix(record.relativePath ?? "");
    if (!file.endsWith(".go")) continue;
    let directory = path.posix.dirname(file);
    while (directory !== "." && directory !== "") {
      directories.add(directory);
      const parent = path.posix.dirname(directory);
      if (parent === directory || parent === ".") break;
      directory = parent;
    }
  }

  const goModules = [];
  for (const directory of [...directories].sort(compareDirectories)) {
    const relativeFile = directory ? `${directory}/go.mod` : "go.mod";
    const absoluteFile = path.join(root, ...relativeFile.split("/"));
    let details;
    try {
      details = await lstat(absoluteFile);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    if (details.isSymbolicLink()) throw new Error(`Go module file ${JSON.stringify(relativeFile)} is a symbolic link.`);
    if (!details.isFile()) continue;
    const modulePath = parseGoModulePath(await readFile(absoluteFile, "utf8"));
    if (modulePath) goModules.push({ directory, modulePath });
  }
  goModules.sort((left, right) => compareText(left.directory, right.directory) || compareText(left.modulePath, right.modulePath));
  return {
    schemaVersion: MODULE_RESOLUTION_SCHEMA_VERSION,
    goModules,
  };
}

export function parseGoModulePath(source) {
  for (const line of String(source).split(/\r?\n/u)) {
    const match = /^\s*module\s+([^\s]+)\s*(?:\/\/.*)?$/u.exec(line);
    if (!match) continue;
    const value = match[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("`") && value.endsWith("`"))) {
      return value.slice(1, -1).trim() || null;
    }
    return value.trim() || null;
  }
  return null;
}

export function moduleKeyForFile(file) {
  const normalized = toPosix(file);
  if (path.posix.extname(normalized).toLowerCase() !== ".go") return `file:${normalized}`;
  const directory = path.posix.dirname(normalized);
  return `go:${directory === "." ? "." : directory}`;
}

export function resolveGoImportModule(sourcePath, specifier, resolution, availableModuleKeys = null) {
  if (path.posix.extname(toPosix(sourcePath)).toLowerCase() !== ".go") return null;
  const modules = compatibleModuleResolution(resolution).goModules
    .filter((item) => specifier === item.modulePath || specifier.startsWith(`${item.modulePath}/`))
    .sort((left, right) => right.modulePath.length - left.modulePath.length || compareText(left.modulePath, right.modulePath));
  const selected = modules[0];
  if (!selected) return null;
  const suffix = specifier === selected.modulePath ? "" : specifier.slice(selected.modulePath.length + 1);
  const directory = path.posix.normalize(path.posix.join(selected.directory || ".", suffix || "."));
  if (directory === ".." || directory.startsWith("../")) return null;
  const key = `go:${directory}`;
  if (availableModuleKeys && !availableModuleKeys.has(key)) return null;
  return key;
}

export function compatibleModuleResolution(value) {
  if (!value || value.schemaVersion !== MODULE_RESOLUTION_SCHEMA_VERSION || !Array.isArray(value.goModules)) {
    return { schemaVersion: MODULE_RESOLUTION_SCHEMA_VERSION, goModules: [] };
  }
  const goModules = value.goModules
    .filter((item) => item && typeof item.directory === "string" && typeof item.modulePath === "string" && item.modulePath)
    .map((item) => ({ directory: toPosix(item.directory), modulePath: item.modulePath }))
    .sort((left, right) => compareText(left.directory, right.directory) || compareText(left.modulePath, right.modulePath));
  return { schemaVersion: MODULE_RESOLUTION_SCHEMA_VERSION, goModules };
}

function compareDirectories(left, right) {
  const depth = left.split("/").filter(Boolean).length - right.split("/").filter(Boolean).length;
  return depth || compareText(left, right);
}
