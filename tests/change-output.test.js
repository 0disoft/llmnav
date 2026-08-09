import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializeProject } from "../src/initializer.js";

const cli = fileURLToPath(new URL("../bin/llmnav.js", import.meta.url));

test("generate --json reports changed cards and affected catalogs", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-change-output-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"change-output-fixture"}\n');
  await mkdir(path.join(root, "src"));
  const sourcePath = path.join(root, "src", "reserve.ts");
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
  assert.ok(output.affectedCatalogs.some((item) => item.kind === "module" && item.id === "billing.credit"));
  assert.equal(output.incremental.files.parsedFiles, 1);
  assert.equal(output.incremental.cards.indexedCards, 1);
  assert.equal(output.transaction.committed, true);
});
