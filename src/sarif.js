/* llmnav/1 module
id=llmnav.diagnostics.sarif
role=Serialize deterministic LLMNav diagnostics as a SARIF 2.1.0 result log.
owns=SARIF schema mapping|diagnostic rule table|artifact locations
excludes=diagnostic discovery|file writes
search=SARIF output|code scanning diagnostics|static analysis report
rel=workflow>llmnav.rules.validate
stability=contract
*/

import { compareText, toPosix } from "./util.js";
import { PACKAGE_VERSION } from "./spec.js";

export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

export function diagnosticsToSarif(diagnostics) {
  const sorted = [...diagnostics].sort(compareDiagnostics);
  const rules = [...new Map(sorted.map((item) => [item.code, item])).values()]
    .sort((left, right) => compareText(left.code, right.code))
    .map((item) => ({
      id: item.code,
      name: item.code,
      shortDescription: { text: `LLMNav diagnostic ${item.code}` },
      defaultConfiguration: { level: sarifLevel(item.severity) },
    }));

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: {
        driver: {
          name: "LLMNav",
          semanticVersion: PACKAGE_VERSION,
          informationUri: "https://github.com/0disoft/llmnav",
          rules,
        },
      },
      results: sorted.map((item) => ({
        ruleId: item.code,
        level: sarifLevel(item.severity),
        message: { text: item.message },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: toPosix(item.file).split("/").map(encodeURIComponent).join("/") },
            region: {
              startLine: Math.max(1, item.line),
              startColumn: Math.max(1, item.column),
            },
          },
        }],
      })),
    }],
  };
}

function sarifLevel(severity) {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "note";
}

function compareDiagnostics(left, right) {
  return compareText(left.file, right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message);
}
