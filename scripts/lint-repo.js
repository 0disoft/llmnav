import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const excluded = new Set([".git", "node_modules", "dist", "coverage"]);
const textExtensions = new Set([".js", ".json", ".md", ".yml", ".yaml", ".toml", ".txt", ".jsonl", ".ts", ".go", ".py"]);
const files = await collect(root);
const errors = [];

for (const file of files) {
  const relative = path.relative(root, file);
  const extension = path.extname(file);
  if (!textExtensions.has(extension) && path.basename(file) !== "LICENSE") continue;
  const content = await readFile(file, "utf8");
  if (content.includes("\r\n")) errors.push(`${relative}: CRLF is not allowed in the repository`);
  for (const [index, line] of content.split("\n").entries()) {
    if (/\s+$/u.test(line)) errors.push(`${relative}:${index + 1}: trailing whitespace`);
  }
  if (extension === ".json") {
    try {
      JSON.parse(content);
    } catch (error) {
      errors.push(`${relative}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (extension === ".js") {
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (checked.status !== 0) errors.push(`${relative}: ${checked.stderr.trim()}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`linted ${files.length} files`);
}

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collect(absolute)));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}
