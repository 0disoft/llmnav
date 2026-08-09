import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { diagnosticsToEditor, getEditorIntegration, renderEditorDiagnostics } from "../src/editor.js";

test("serializes sorted zero-based editor diagnostic ranges", () => {
  const diagnostics = [
    diagnostic("src/z.ts", 3, 8, "warning", "LNV002", "Later warning"),
    diagnostic("src/a.ts", 1, 1, "error", "LNV001", "First error"),
    diagnostic("src/a.ts", 2, 4, "info", "LNV003", "Second info"),
  ];
  const report = diagnosticsToEditor(diagnostics);
  assert.equal(report.coordinateBase, 0);
  assert.deepEqual(report.documents.map((item) => item.path), ["src/a.ts", "src/z.ts"]);
  assert.deepEqual(report.documents[0].diagnostics[0].range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  });
  assert.deepEqual(report.documents[0].diagnostics.map((item) => item.severity), [1, 3]);
  assert.deepEqual(report.counts, { error: 1, warning: 1, info: 1 });
  assert.equal(renderEditorDiagnostics(diagnostics), renderEditorDiagnostics([...diagnostics].reverse()));
});

test("publishes a VS Code task whose matcher accepts LLMNav text diagnostics", () => {
  const integration = getEditorIntegration("vscode");
  assert.equal(integration.target, ".vscode/tasks.json");
  const task = integration.config.tasks[0];
  assert.deepEqual(task.args, ["exec", "--", "llmnav", "check"]);
  const match = new RegExp(task.problemMatcher.pattern.regexp, "u").exec(
    "src/auth.ts:12:4 warning LNV007 Search phrase is saturated.",
  );
  assert.deepEqual(match?.slice(1), [
    "src/auth.ts",
    "12",
    "4",
    "warning",
    "LNV007",
    "Search phrase is saturated.",
  ]);
});

test("prints the VS Code integration outside a repository", () => {
  const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "editor", "vscode"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).editor, "vscode");
});

function diagnostic(file, line, column, severity, code, message) {
  return { file, line, column, severity, code, message };
}
