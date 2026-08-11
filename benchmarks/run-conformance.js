import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConformanceMatrix, runConformanceMatrix } from "./conformance.js";
import { projectRelativePath, stableStringify } from "../src/util.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const matrixArgument = optionValue(args, "--matrix") ?? "benchmarks/conformance-matrix.json";
const matrixPath = path.resolve(packageRoot, projectRelativePath(matrixArgument, "matrix path"));
const matrix = await loadConformanceMatrix(matrixPath);
const report = await runConformanceMatrix(matrix, { packageRoot });
const outputArgument = optionValue(args, "--output");
if (outputArgument) {
  const outputPath = path.resolve(packageRoot, projectRelativePath(outputArgument, "output path"));
  await writeFile(outputPath, stableStringify(report));
}
process.stdout.write(stableStringify(report));
process.exitCode = report.verdict === "fail" ? 1 : 0;

function optionValue(values, name) {
  const index = values.indexOf(name);
  if (index < 0) return null;
  if (!values[index + 1] || values[index + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
  return values[index + 1];
}
