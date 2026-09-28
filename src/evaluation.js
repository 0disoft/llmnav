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
    const expectNoResults = record?.expectNoResults === true;
    const expected = expectNoResults ? [] : record?.expected;
    if (!record || typeof record.query !== "string" || !record.query.trim() ||
      (Object.hasOwn(record, "expectNoResults") && !expectNoResults) ||
      (expectNoResults ? record.expected !== undefined :
        !Array.isArray(expected) || expected.length === 0 ||
          !expected.every((id) => typeof id === "string" && id.trim()))) {
      return {
        ok: false,
        status: "invalid",
        minimumCases,
        errors: [`${queryPath}: each record requires a non-empty query and either non-empty expected IDs or expectNoResults:true`],
        cases,
        metrics: emptyMetrics(),
      };
    }
    const results = queryPreparedIndex(index, searchIndex, record.query, { top: Math.max(options.top ?? 5, 5), lexicon, graph });
    const ids = results.map((result) => result.id);
    const firstRank = expectNoResults ? -1 : ids.findIndex((id) => expected.includes(id));
    const noResultPass = expectNoResults && ids.length === 0;
    cases.push({
      query: record.query,
      expected,
      expectNoResults,
      actual: ids,
      rank: firstRank < 0 ? null : firstRank + 1,
      passAt1: noResultPass || firstRank === 0,
      passAt5: noResultPass || (firstRank >= 0 && firstRank < 5),
    });
  }

  const total = cases.length;
  const positiveCases = cases.filter((item) => !item.expectNoResults);
  const positiveTotal = positiveCases.length;
  const negativeTotal = total - positiveTotal;
  const negativePassed = cases.filter((item) => item.expectNoResults && item.passAt5).length;
  const metrics = total === 0
    ? emptyMetrics()
    : {
        total,
        positiveTotal,
        negativeTotal,
        negativePassed,
        recallAt1: positiveTotal === 0 ? 0 : positiveCases.filter((item) => item.passAt1).length / positiveTotal,
        recallAt5: positiveTotal === 0 ? 0 : positiveCases.filter((item) => item.passAt5).length / positiveTotal,
        meanReciprocalRank: positiveTotal === 0 ? 0 :
          positiveCases.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / positiveTotal,
      };
  const thresholdsPassed = positiveTotal > 0 && negativePassed === negativeTotal &&
    metrics.recallAt1 >= config.evaluation.minimumRecallAt1 &&
    metrics.recallAt5 >= config.evaluation.minimumRecallAt5;
  const status = total === 0 ? "unmeasured" :
    total < minimumCases ? "insufficient" : thresholdsPassed ? "passed" : "failed";
  const ok = status === "passed" || (status === "unmeasured" && minimumCases === 0);
  return { ok, status, minimumCases, errors: [], cases, metrics, thresholds: config.evaluation };
}

function emptyMetrics() {
  return { total: 0, positiveTotal: 0, negativeTotal: 0, negativePassed: 0, recallAt1: 0, recallAt5: 0, meanReciprocalRank: 0 };
}
