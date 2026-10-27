import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzePython } from "../src/adapters/python.js";
import { analyzeProject } from "../src/analysis.js";

const pythonMissing = spawnSync("python", ["--version"], { windowsHide: true }).status !== 0;
async function fixture(context, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-python-positions-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "main.py");
  await writeFile(file, source);
  return { root, file };
}

test("Python positions follow physical lines and preserve UTF-16 offsets across Unicode boundaries", { skip: pythonMissing }, async context => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const source = "\ufefftext = '\u0085\u2028\u2029한글😀'" + ending +
      "def xy(a: int):" + ending + "    return a" + ending +
      "한글 = 1; 값 = 2; final: str = 'ok'" + ending;
    const { root, file } = await fixture(context, source);
    const result = await analyzePython(root, [file]);
    const rows = result.declarations;
    for (const [symbol, at, line] of [["xy", "def xy", 2], ["a", "a: int", 2], ["한글", "한글 =", 4], ["값", "값 =", 4], ["final", "final:", 4]]) {
      const declaration = rows.find(row => row.symbol === symbol);
      assert.equal(declaration.offset, source.indexOf(at), `${JSON.stringify(ending)} ${symbol}`);
      assert.equal(declaration.line, line);
    }
    assert.equal(rows.find(row => row.symbol === "a").parent, rows.find(row => row.symbol === "xy").key);
    // Repeated analysis must not retain a previous file's line correction table.
    assert.deepEqual(await analyzePython(root, [file]), result);
  }
});

test("Python generated graphs retain reviewed card bindings after Unicode string separators", { skip: pythonMissing }, async context => {
  const source = "text = '\u2028한글한글한글'\n" +
      "# llmnav/1 symbol\n# id=positions.convert\n# role=Convert a value.\n# search=position conversion|Unicode location\n# stability=contract\n# /llmnav\n" +
    "def xy(a: int):\n    return a\n";
  const { root } = await fixture(context, source);
  await mkdir(path.join(root, ".llmnav"));
  await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "positions" }));
  const result = await analyzeProject(root, { language: "python", metadata: true });
  const method = result.graph.definitions.find(row => row.symbol === "xy");
  assert.equal(method.id, "positions.convert");
  assert.equal(result.counts.cardBindings, 1);
  assert.equal(method.line, 8);
});

test("dense Python declarations keep distinct byte-to-UTF16 positions and unknown types", { skip: pythonMissing }, async context => {
  for (const prefix of ["tag = 'ascii'; ", "tag = '한글😀'; "]) {
    const count = 2000;
    const source = prefix + Array.from({ length: count }, (_, i) => `v${i}: int = ${i}`).join("; ") + "\n";
    const { root, file } = await fixture(context, source);
    const rows = (await analyzePython(root, [file])).declarations;
    assert.equal(rows.length, count + 2);
    const lookup = new Map(rows.map(row => [row.symbol, row]));
    for (let i = 0; i < count; i++) {
      const row = lookup.get(`v${i}`);
      assert.equal(row.offset, source.indexOf(`v${i}:`));
      assert.equal(row.metadata.type, "int");
      assert.equal(row.metadata.typeOrigin, "declared");
    }
    assert.equal(lookup.get("tag").metadata.type, null);
    assert.equal(lookup.get("tag").metadata.typeOrigin, "unknown");
  }
});
