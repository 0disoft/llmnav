import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectSession } from "../src/search.js";
import { compareText, sha256 } from "../src/util.js";

// Retrospective diagnostic cases, not a sealed holdout or verbatim user prompts.
// Freeze queries and baseline patterns before running; do not tune them to a result.
export const replayCases = [
  { id: "lock-filesystem", change: "5b0d837", query: "Explain which filesystem capability is required when acquiring a generation lock fails.", pattern: "hard.?link|acquir.*lock|lock.*publish", expected: "src/transaction.js" },
  { id: "context-edge-limit", change: "34f56a6", query: "A context request still follows relationships when its maximum edge count is zero.", pattern: "maxEdges|edge.*limit", expected: "src/search.js" },
  { id: "audit-disposition", change: "592849f", query: "Find why unannotated files were suppressed from the architectural coverage audit.", pattern: "disposition|suppress", expected: "src/audit.js" },
  { id: "go-import-boundary", change: "fcd40cb", query: "Resolve a full Go module import to the correct package boundary.", pattern: "go.*module|module.*import|package.*boundar", expected: "src/module-resolution.js" },
  { id: "format-migration", change: "839ab1c", query: "Upgrade incompatible generated cache formats without leaving partial files after failure.", pattern: "migrat|format.*compatib", expected: "src/migration.js" },
  { id: "shard-postings", change: "d30d800", query: "Remove the repeated scan of search postings when generating many shards.", pattern: "shard.*post|post.*shard", expected: "src/search-shards.js" },
];

export function rankEvidence(paths, expected, limit = 5) {
  const unique = [...new Set(paths)];
  const position = unique.indexOf(expected);
  const rank = position < 0 ? null : position + 1;
  return { candidates: unique.length, rank, foundAt1: rank === 1, foundAt5: rank !== null && rank <= limit, firstFive: unique.slice(0, limit) };
}

export async function runNavigationReplay(root) {
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "Git evidence unavailable");
    return result.stdout.trim();
  };
  const sourcePaths = git(["ls-files", "--", "src", "bin"]).split(/\r?\n/u)
    .filter((file) => file.endsWith(".js"))
    .sort(compareText);
  const sourceSet = new Set(sourcePaths);
  const sources = await Promise.all(sourcePaths.map(async (file) => [file, await readFile(path.join(root, file), "utf8")]));
  const session = await createProjectSession(root);
  const rows = [];
  for (const item of replayCases) {
    assert.ok(sourceSet.has(item.expected), `Missing current target: ${item.expected}`);
    const changedFiles = git(["show", "--format=", "--name-only", item.change, "--"]).split(/\r?\n/u);
    assert.ok(changedFiles.includes(item.expected), `Historical change does not support target: ${item.id}`);
    const expression = new RegExp(item.pattern, "iu");
    const baselinePaths = sources.filter(([, text]) => text.split(/\r?\n/u).some((line) => expression.test(line))).map(([file]) => file);
    // The query API currently permits up to 100 cards. Hold if this would truncate
    // the source-scope projection, rather than silently counting hidden hits as misses.
    const results = session.query(item.query, { top: 100 });
    assert.ok(results.length < 100, "Replay scope projection requires an untruncated query result");
    const queryPaths = results.map((result) => result.location.path).filter((file) => sourceSet.has(file));
    rows.push({ ...item, baseline: rankEvidence(baselinePaths, item.expected), llmnav: rankEvidence(queryPaths, item.expected) });
  }
  return {
    schemaVersion: 1,
    evaluatedCommit: git(["rev-parse", "HEAD"]),
    harnessHash: sha256(await readFile(fileURLToPath(import.meta.url), "utf8")),
    casesHash: sha256(JSON.stringify(replayCases)),
    sourceHash: sha256(JSON.stringify(sources)),
    sourceFiles: sourcePaths.length,
    method: "One fixed case-insensitive line-regex query versus one LLMNav query per case. Both output scopes are tracked src/bin JavaScript files. Regex results sort by path; LLMNav results preserve rank and deduplicate paths. Existing source annotations remain visible to both approaches.",
    summary: {
      cases: rows.length,
      baselineAt1: rows.filter((row) => row.baseline.foundAt1).length,
      baselineAt5: rows.filter((row) => row.baseline.foundAt5).length,
      llmnavAt1: rows.filter((row) => row.llmnav.foundAt1).length,
      llmnavAt5: rows.filter((row) => row.llmnav.foundAt5).length,
      searchRequestsPerCase: { baseline: 1, llmnav: 1 },
      agentFilesOpened: null,
      agentToolCalls: null,
      uncachedTokens: null,
      taskCompletionRate: null,
    },
    limitations: [
      "Retrospective author-curated English symptom paraphrases and regexes; expected paths were known during case design. Not representative traffic, a blind holdout, or a model trial.",
      "Historical target membership is checked, but replay uses current corrected source rather than reproducing the original bug or completing a development task.",
      "The baseline is deterministic regex file discovery, not an adaptive developer using rg; alphabetical rank is not a human relevance ranking.",
      "Candidate rank is not files opened, tool calls to completion, token savings, elapsed task time, or successful edits. LLMNav scoring still uses its complete repository index before output-scope filtering.",
    ],
    rows,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runNavigationReplay(path.resolve(fileURLToPath(new URL("..", import.meta.url)))), null, 2));
}
