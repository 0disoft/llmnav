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
  const { config } = await loadConfig(root);
  const { index, lexicon, searchIndex } = await loadSearchData(root);
  const queryPath = path.resolve(root, options.file ?? config.evaluation.queryFile);
  await assertNoSymlinkTraversal(root, queryPath, "evaluation query file");
  const parsed = parseJsonLines(await readText(queryPath, ""), queryPath);
  if (parsed.errors.length > 0) {
    return { ok: false, errors: parsed.errors, cases: [], metrics: emptyMetrics() };
  }

  const cases = [];
  for (const record of parsed.records) {
    if (!record || typeof record.query !== "string" || !Array.isArray(record.expected) || record.expected.length === 0) {
      return {
        ok: false,
        errors: [`${queryPath}: each record requires query:string and expected:string[]`],
        cases,
        metrics: emptyMetrics(),
      };
    }
    const results = queryPreparedIndex(index, searchIndex, record.query, { top: Math.max(options.top ?? 5, 5), lexicon });
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
  const ok =
    total === 0 ||
    (metrics.recallAt1 >= config.evaluation.minimumRecallAt1 &&
      metrics.recallAt5 >= config.evaluation.minimumRecallAt5);
  return { ok, errors: [], cases, metrics, thresholds: config.evaluation };
}

function emptyMetrics() {
  return { total: 0, recallAt1: 0, recallAt5: 0, meanReciprocalRank: 0 };
}
