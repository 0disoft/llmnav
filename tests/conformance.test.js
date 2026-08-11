import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runConformanceMatrix,
  validateConformanceMatrix,
} from "../benchmarks/conformance.js";
import { initializeProject } from "../src/initializer.js";

test("cross-repository conformance separates passing evidence from held language coverage", async (context) => {
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "llmnav-conformance-"));
  context.after(() => rm(packageRoot, { recursive: true, force: true }));
  const repository = path.join(packageRoot, "fixture");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await writeFile(path.join(repository, "package.json"), '{"name":"fixture"}\n');
  await writeFile(
    path.join(repository, "src", "reserve.js"),
    `/* llmnav/1 module\nid=fixture.credit.reserve\nrole=Reserve one credit balance before external work begins.\nowns=credit reservation\nsearch=reserve credit|credit balance\ninvariant=One request creates at most one reservation.\nstability=contract\n*/\nexport function reserveCredit() {}\n`,
  );
  const initialized = await initializeProject(repository, { agents: ["none"] });
  assert.equal(initialized.ok, true, JSON.stringify(initialized.generated?.diagnostics ?? [], null, 2));
  await writeFile(
    path.join(repository, ".llmnav", "eval", "queries.jsonl"),
    '{"query":"reserve one credit balance","expected":["fixture.credit.reserve"]}\n',
  );

  const matrix = {
    schemaVersion: 1,
    requiredLanguages: ["javascript", "go"],
    repositories: [
      { id: "fixture", root: "fixture", languages: ["javascript"], minimumCases: 1, enabled: true },
      { id: "go-fixture", root: "go-fixture", languages: ["go"], minimumCases: 1, enabled: false },
    ],
  };
  const report = await runConformanceMatrix(matrix, {
    packageRoot,
    measuredAt: "2026-08-11T00:00:00.000Z",
  });

  assert.equal(report.verdict, "held", JSON.stringify(report, null, 2));
  assert.equal(report.repositories[0].verdict, "pass");
  assert.equal(report.repositories[0].evidence.evaluation.repeatable, true);
  assert.equal(report.repositories[0].evidence.cache.fresh, true);
  assert.equal(report.repositories[1].verdict, "held");
  assert.deepEqual(report.summary.heldLanguages, ["go"]);
});

test("conformance matrix rejects absolute repository roots and duplicate IDs", () => {
  assert.throws(
    () => validateConformanceMatrix({
      schemaVersion: 1,
      requiredLanguages: ["javascript"],
      repositories: [
        { id: "fixture", root: path.resolve("fixture"), languages: ["javascript"], minimumCases: 1, enabled: true },
      ],
    }),
    /root must be relative/u,
  );
  assert.throws(
    () => validateConformanceMatrix({
      schemaVersion: 1,
      requiredLanguages: ["javascript"],
      repositories: [
        { id: "fixture", root: "a", languages: ["javascript"], minimumCases: 1, enabled: true },
        { id: "fixture", root: "b", languages: ["javascript"], minimumCases: 1, enabled: true },
      ],
    }),
    /Duplicate conformance repository id/u,
  );
});
