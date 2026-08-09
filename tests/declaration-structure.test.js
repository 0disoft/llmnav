import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectBoundaries } from "../src/boundaries.js";
import { findAttachedDeclaration } from "../src/declaration.js";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { parseLlmnavBlocks } from "../src/parser.js";

test("enriches TypeScript and Go declarations with stable visibility and body hashes", () => {
  const typescript = `${card("api.user.load")}export async function loadUser(id: string): Promise<string> {\n  return id;\n}\n`;
  const [typescriptBlock] = parseLlmnavBlocks(typescript, "src/api/user.ts");
  const typescriptDeclaration = findAttachedDeclaration(typescript, typescriptBlock, "src/api/user.ts");
  assert.equal(typescriptDeclaration.language, "typescript");
  assert.equal(typescriptDeclaration.exported, true);
  assert.equal(typescriptDeclaration.visibility, "public");
  assert.equal(typescriptDeclaration.receiver, null);
  assert.equal(typescriptDeclaration.endOffset, typescript.lastIndexOf("}") + 1);
  assert.match(typescriptDeclaration.bodyHash, /^[a-f0-9]{64}$/u);

  const go = `${card("billing.credit.reserve")}func (ledger *Ledger) ReserveCredits(amount int) error {\n\treturn nil\n}\n`;
  const [goBlock] = parseLlmnavBlocks(go, "billing/reserve.go");
  const goDeclaration = findAttachedDeclaration(go, goBlock, "billing/reserve.go");
  assert.equal(goDeclaration.language, "go");
  assert.equal(goDeclaration.exported, true);
  assert.equal(goDeclaration.visibility, "public");
  assert.equal(goDeclaration.receiver, "Ledger");
});

test("isolates symbol body hashes and detects local structural boundaries", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-declaration-hash-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"declaration-hash-fixture"}\n');
  await mkdir(path.join(root, "src", "routes"), { recursive: true });
  const sourcePath = path.join(root, "src", "routes", "credits.ts");
  await writeFile(sourcePath, `${card("billing.credit.reserve")}export function reserve(): number { return 1; }\n${card("billing.credit.capture")}export function capture(): number { return 2; }\n`);

  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);
  const first = JSON.parse(await readFile(path.join(root, ".llmnav", "cache", "index.json"), "utf8"));
  const firstReserve = first.cards.find((item) => item.id === "billing.credit.reserve");
  const firstCapture = first.cards.find((item) => item.id === "billing.credit.capture");
  assert.deepEqual(firstReserve.boundaries, [{ kind: "route", confidence: "high", evidence: ["path"] }]);

  const source = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, source.replace("return 2", "return 3"));
  const second = await generateProject(root);
  const secondReserve = second.index.cards.find((item) => item.id === "billing.credit.reserve");
  const secondCapture = second.index.cards.find((item) => item.id === "billing.credit.capture");
  assert.equal(secondReserve.hashes.body, firstReserve.hashes.body);
  assert.notEqual(secondCapture.hashes.body, firstCapture.hashes.body);

  assert.deepEqual(
    detectBoundaries({
      relativePath: "migrations/001_credit.sql",
      card: { effect: ["event.emit(billing.changed)"], risk: ["migration"] },
    }).map((item) => item.kind),
    ["event", "migration"],
  );
});

function card(id) {
  return `/* llmnav/1 symbol\nid=${id}\nrole=Execute the named contract boundary deterministically.\nsearch=${id.replaceAll(".", " ")}|contract boundary\nstability=contract\n*/\n`;
}
