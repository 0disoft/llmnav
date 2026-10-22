import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { describeAffectedBoundaries } from "../src/changes.js";
import { initializeProject } from "../src/initializer.js";
import { compareText } from "../src/util.js";

const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));

test("generate --json reports changed cards, boundaries, and affected catalogs", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-change-output-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"change-output-fixture"}\n');
  await mkdir(path.join(root, "src", "routes"), { recursive: true });
  const sourcePath = path.join(root, "src", "routes", "reserve.ts");
  await writeFile(
    sourcePath,
    `/* llmnav/1 symbol\nid=billing.credit.reserve\nrole=Reserve credits before a generation job starts.\nsearch=credit hold|reserve credits\nstability=contract\n*/\nexport function reserveCredits(): number { return 1; }\n`,
  );
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);

  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("Reserve credits", "Atomically reserve credits"));
  const child = spawnSync(process.execPath, [cli, "generate", "--root", root, "--json"], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.ok, true);
  assert.deepEqual(output.changedCards.map((item) => item.id), ["billing.credit.reserve"]);
  assert.ok(output.changedCards[0].dimensions.includes("semantic"));
  assert.deepEqual(output.affectedBoundaries, [{
    id: "billing.credit.reserve",
    change: "modified",
    dimensions: output.changedCards[0].dimensions,
    modules: ["billing.credit"],
    boundaries: [{ kind: "route", confidence: "high", evidence: ["path"] }],
    relatedIds: [],
    dependentIds: [],
  }]);
  assert.ok(output.affectedCatalogs.some((item) => item.kind === "module" && item.id === "billing.credit"));
  assert.ok(output.affectedCatalogs.some((item) => item.kind === "prompt-prefix"));
  assert.equal(output.incremental.files.parsedFiles, 1);
  assert.equal(output.incremental.cards.indexedCards, 1);
  assert.equal(output.transaction.committed, true);
});

test("affected boundaries index dependents from both index generations", () => {
  const config = { generation: { moduleDepth: 2 } };
  const target = "core.target";
  const card = (id, relations = []) => ({ id, rel: relations, boundaries: [], stability: "implementation" });
  const previousCards = [card(target, [])];
  const currentCards = [card(target, [])];
  for (let index = 0; index < 140; index += 1) {
    const id = `feature.user${String(index).padStart(3, "0")}`;
    previousCards.push(card(id, [`uses>${target}`]));
    if (index % 2 === 0) currentCards.push(card(id, [`uses>${target}`]));
  }
  // The relation was dropped in the current index; the previous declaration still counts.
  previousCards.push(card("core.legacy", [`uses>${target}`]));
  currentCards.push(card("core.legacy", []));
  for (let index = 0; index < 120; index += 1) {
    currentCards.push(card(`noise.entry${String(index).padStart(3, "0")}`, ["uses>other.target"]));
  }

  const [boundary] = describeAffectedBoundaries(
    [{ id: target, change: "modified", dimensions: ["body"] }],
    config,
    { cards: previousCards },
    { cards: currentCards },
  );
  const reference = [...new Set(
    [...previousCards, ...currentCards]
      .filter((item) => (item.rel ?? []).some((relation) => relation.endsWith(`>${target}`)))
      .map((item) => item.id),
  )].sort(compareText);
  assert.deepEqual(boundary.dependentIds, reference);
  assert.equal(boundary.dependentIds.length, 141);
  assert.ok(boundary.dependentIds.includes("core.legacy"));
  assert.ok(!boundary.dependentIds.some((id) => id.startsWith("noise.")));
});
