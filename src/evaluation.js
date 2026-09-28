/* llmnav/1 module
id=llmnav.eval.measure
role=Measure whether repository task queries retrieve expected semantic IDs within configured rank gates.
owns=search regression tests|recall metrics|evaluation gates
excludes=benchmark task execution|model quality scoring
search=search recall|navigation benchmark|query regression
rel=workflow>llmnav.search.query
stability=architecture
*/

import path from "node:path";
import { loadConfig } from "./config.js";
import { loadSearchData, queryPreparedIndex } from "./search.js";
import { assertNoSymlinkTraversal, parseJsonLines, readText } from "./util.js";

export async function evaluateProject(root, options = {}) {
  const minimumCases = options.minimumCases ?? 0;
  if (!Number.isSafeInteger(minimumCases) || minimumCases < 0) {
    throw new RangeError("minimumCases must be a non-negative safe integer.");
  }
  const { config } = await loadConfig(root);
  const { index, lexicon, searchIndex, graph } = await loadSearchData(root);
  const queryPath = path.resolve(root, options.file ?? config.evaluation.queryFile);
  await assertNoSymlinkTraversal(root, queryPath, "evaluation query file");
  const parsed = parseJsonLines(await readText(queryPath, ""), queryPath);
  if (parsed.errors.length > 0) {
    return { ok: false, status: "invalid", minimumCases, errors: parsed.errors, cases: [], metrics: emptyMetrics() };
  }

  const cases = [];
  for (const record of parsed.records) {
    if (!record || typeof record.query !== "string" || !record.query.trim() ||
      !Array.isArray(record.expected) || record.expected.length === 0 ||
      !record.expected.every((id) => typeof id === "string" && id.trim())) {
      return {
        ok: false,
        status: "invalid",
        minimumCases,
        errors: [`${queryPath}: each record requires a non-empty query and non-empty expected IDs`],
        cases,
        metrics: emptyMetrics(),
      };
    }
    const results = queryPreparedIndex(index, searchIndex, record.query, { top: Math.max(options.top ?? 5, 5), lexicon, graph });
    const ids = results.map((result) => result.id);
    const firstRank = ids.findIndex((id) => record.expected.includes(id));
    cases.push({
      query: record.query,
      expected: record.expected,
      actual: ids,
      rank: firstRank < 0 ? null : firstRank + 1,
      passAt1: firstRank === 0,
      passAt5: firstRank >= 0 && firstRank < 5,
    });
  }

  const total = cases.length;
  const metrics = total === 0
    ? emptyMetrics()
    : {
        total,
        recallAt1: cases.filter((item) => item.passAt1).length / total,
        recallAt5: cases.filter((item) => item.passAt5).length / total,
        meanReciprocalRank: cases.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / total,
      };
  const thresholdsPassed = metrics.recallAt1 >= config.evaluation.minimumRecallAt1 &&
    metrics.recallAt5 >= config.evaluation.minimumRecallAt5;
  const status = total === 0 ? "unmeasured" :
    total < minimumCases ? "insufficient" : thresholdsPassed ? "passed" : "failed";
  const ok = status === "passed" || (status === "unmeasured" && minimumCases === 0);
  return { ok, status, minimumCases, errors: [], cases, metrics, thresholds: config.evaluation };
}

function emptyMetrics() {
  return { total: 0, recallAt1: 0, recallAt5: 0, meanReciprocalRank: 0 };
}
