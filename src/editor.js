/* llmnav/1 module
id=llmnav.diagnostics.editor
role=Serialize deterministic editor ranges and publish bounded editor task integrations.
owns=editor diagnostic schema|zero-based ranges|VS Code task configuration
excludes=editor extension runtime|absolute workspace URIs|source mutation
search=editor diagnostics|VS Code problem matcher|problems panel|diagnostic range
rel=workflow>llmnav.rules.validate
stability=contract
*/

import { compareText, stableStringify, toPosix } from "./util.js";

export const EDITOR_DIAGNOSTIC_SCHEMA_VERSION = 1;
export const EDITOR_INTEGRATION_SCHEMA_VERSION = 1;

export function diagnosticsToEditor(diagnostics) {
  const byPath = new Map();
  const sorted = [...diagnostics].sort(compareDiagnostics);
  for (const diagnostic of sorted) {
    const documentPath = toPosix(diagnostic.file);
    const items = byPath.get(documentPath) ?? [];
    const line = Math.max(0, Number(diagnostic.line ?? 1) - 1);
    const character = Math.max(0, Number(diagnostic.column ?? 1) - 1);
    items.push({
      range: {
        start: { line, character },
        end: { line, character: character + 1 },
      },
      severity: severityNumber(diagnostic.severity),
      level: diagnostic.severity,
      code: diagnostic.code,
      source: "llmnav",
      message: diagnostic.message,
    });
    byPath.set(documentPath, items);
  }
  return {
    schemaVersion: EDITOR_DIAGNOSTIC_SCHEMA_VERSION,
    source: "llmnav",
    coordinateBase: 0,
    counts: countLevels(sorted),
    documents: [...byPath.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([path, items]) => ({ path, diagnostics: items })),
  };
}

export function renderEditorDiagnostics(diagnostics) {
  return stableStringify(diagnosticsToEditor(diagnostics));
}

export function getEditorIntegration(name) {
  if (name !== "vscode") throw editorUsageError(`Unknown editor integration ${JSON.stringify(name)}.`);
  return {
    schemaVersion: EDITOR_INTEGRATION_SCHEMA_VERSION,
    editor: "vscode",
    target: ".vscode/tasks.json",
    config: {
      version: "2.0.0",
      tasks: [{
        label: "LLMNav: check",
        type: "shell",
        command: "npm",
        args: ["exec", "--", "llmnav", "check"],
        group: { kind: "test", isDefault: false },
        problemMatcher: {
          owner: "llmnav",
          fileLocation: ["relative", "${workspaceFolder}"],
          source: "llmnav",
          pattern: {
            regexp: "^(.+):(\\d+):(\\d+) (error|warning|info) (LNV\\d+) (.+)$",
            file: 1,
            line: 2,
            column: 3,
            severity: 4,
            code: 5,
            message: 6,
          },
        },
        presentation: { reveal: "silent", panel: "dedicated" },
      }],
    },
  };
}

function severityNumber(level) {
  if (level === "error") return 1;
  if (level === "warning") return 2;
  return 3;
}

function countLevels(diagnostics) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const item of diagnostics) counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  return counts;
}

function compareDiagnostics(left, right) {
  return compareText(left.file, right.file) || left.line - right.line || left.column - right.column ||
    compareText(left.code, right.code) || compareText(left.message, right.message);
}

function editorUsageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}
