/* llmnav/1 module
id=llmnav.eval.serena-navigation
role=Compare semantic lookup on copied real source using Serena and the frozen declaration oracles.
owns=Serena retrieval measurements|symbol input mapping|external tool provenance
excludes=model coding outcomes|timing superiority claims
search=Serena comparison|semantic lookup evaluation|language server benchmark
invariant=Tool failures remain failed observations and never become substitute text searches.
stability=architecture
*/

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { digest, rankSourceCandidates, readOriginals, summarizeMeasurements } from "./real-navigation.js";
import { prepareCorpus } from "./evaluation-corpus.js";
import { createMcpClient, serenaArguments, SERENA_VERSION, toolText } from "./mcp-client.js";
import { sha256, stableStringify } from "../src/util.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function serenaCandidates(text) {
  const symbols = JSON.parse(text);
  assert.ok(Array.isArray(symbols), "Serena symbol response must be an array");
  return symbols.map(symbol => {
    assert.ok(typeof symbol.relative_path === "string" && Number.isInteger(symbol.body_location?.start_line), "Missing Serena symbol location");
    return { path: symbol.relative_path.replaceAll("\\", "/"), line: symbol.body_location.start_line + 1, symbol: symbol.name_path };
  });
}

export async function runSerenaNavigation(options) {
  const planText = await readFile(path.join(here, "real-navigation-cases.json"), "utf8");
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), serenaVersion: SERENA_VERSION,
    planHash: sha256(planText), harnessHash: sha256(await readFile(fileURLToPath(import.meta.url), "utf8")),
    environment: { platform: process.platform, node: process.version, filesystemCacheFlushed: false }, repositories: [],
    limitations: ["One author-curated identifier lookup per task, not model coding success or a sealed holdout.",
      "Go LSP exposes flat method names (verified on a separate Box.Read fixture); queries use the frozen identifier without a receiver. No oracle file paths are supplied.",
      "Different execution dates and cached dependencies prevent speedup claims against the earlier retrieval pilot.",
      "Serena initialization is separate; the first lookup includes lazy language-server work. Dependency installation is excluded."] };
  for (const entry of JSON.parse(planText).repositories) {
    const original = path.resolve(entry.language === "go" ? options.goRoot : options.typescriptRoot);
    const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-serena-navigation-"));
    let client;
    try {
      const sources = await prepareCorpus(original, root, entry);
      const corpusHash = digest(sources);
      const start = performance.now();
      client = createMcpClient(options.uvx ?? "uvx", serenaArguments(root), { cwd: root, env: options.env });
      const server = await client.initialize();
      const { tools } = await client.request("tools/list");
      const tool = tools.find(item => item.name === "find_symbol");
      assert.ok(tool?.inputSchema.properties.name_path_pattern, "Installed Serena lacks the measured symbol tool");
      const initializationMs = performance.now() - start;
      const rows = [];
      for (const item of entry.cases) {
        const source = sources.find(file => file.path === item.path)?.text;
        assert.ok(source?.includes(item.anchor), `Missing declaration oracle: ${item.id}`);
        const expectedLine = source.slice(0, source.indexOf(item.anchor)).split("\n").length;
        const arguments_ = { name_path_pattern: item.pattern, include_body: false };
        const lookupStarted = performance.now();
        let candidates = [], responseBytes = 0, error = null;
        try {
          const response = await client.request("tools/call", { name: "find_symbol", arguments: arguments_ });
          responseBytes = Buffer.byteLength(JSON.stringify(response));
          candidates = serenaCandidates(toolText(response));
        } catch (failure) { error = String(failure.message).replaceAll(root, "<workspace>").replaceAll(os.homedir(), "<home>"); }
        const lookupMs = performance.now() - lookupStarted;
        let inspectedSourceBytes = 0;
        const inspectedFiles = [];
        for (const file of [...new Set(candidates.slice(0, 5).map(candidate => candidate.path))]) {
          assert.ok(!path.isAbsolute(file) && !file.split("/").includes(".."), "Unsafe Serena result path");
          inspectedSourceBytes += Buffer.byteLength(await readFile(path.join(root, file)));
          inspectedFiles.push(file);
          if (file === item.path) break;
        }
        rows.push({ task: item.id, condition: "serena", arguments: arguments_, lookupMs, error, responseBytes,
          expectedPath: item.path, expectedLine, candidates, ...rankSourceCandidates(candidates, item.path, expectedLine),
          inspectedFiles, inspectedSourceBytes, toolCalls: 1 + inspectedFiles.length });
      }
      const originalsUnchanged = corpusHash === digest(await readOriginals(original, sources));
      assert.ok(originalsUnchanged, "Original source changed during evaluation");
      report.repositories.push({ id: entry.id, corpusHash, files: sources.length, server: server.serverInfo,
        toolSchemaHash: sha256(JSON.stringify(tool.inputSchema)), initializationMs, originalsUnchanged, rows,
        summary: { ...summarizeMeasurements(rows, "serena"), errors: rows.filter(row => row.error).length } });
    } finally {
      await client?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
  assert.ok(args.includes("--typescript-root") && args.includes("--go-root") && args.includes("--output"), "Supply corpus roots and --output");
  const result = await runSerenaNavigation({ typescriptRoot: option("--typescript-root"), goRoot: option("--go-root") });
  await mkdir(path.dirname(path.resolve(option("--output"))), { recursive: true });
  await writeFile(option("--output"), stableStringify(result));
  console.log(JSON.stringify(result.repositories.map(item => ({ id: item.id, ...item.summary }))));
}
