// Runs outside evaluated workspaces. Only production modules cross into this grader.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function runPolicyOracle(engine, task) {
  const load = name => import(pathToFileURL(path.join(engine, "src", name)));
  const { discoverProject } = await load("discovery.js");
  const { generateProject } = await load("generator.js");
  const { buildContext, createProjectSession } = await load("search.js");
  const { executeAgentOperation, getAgentToolDefinitions } = await load("agent-protocol.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-policy-oracle-"));
  const checks = [];
  const check = async (name, work) => {
    try { await work(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error.code ?? error.name,
      ...(error.code === "ERR_ASSERTION" ? { detail: error.message.slice(0, 1500).replaceAll(root, "<fixture>") } : {}) }); }
  };
  const cli = args => spawnSync(process.execPath, [path.join(engine, "bin/llmnav.js"), ...args, "--root", root, "--json"],
    { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const bytes = result => result.results.reduce((sum, item) => sum + Buffer.byteLength(item.sourceExcerpt?.text ?? ""), 0);
  try {
    await mkdir(path.join(root, ".llmnav"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, ".llmnav/config.json"), JSON.stringify({ repositoryId: "policy-fixture", sourceRoots: ["src"] }));
    for (const [index, id] of ["policy.root", "policy.outgoing", "policy.incoming"].entries()) {
      const relation = index === 0 ? "rel=policy>policy.outgoing\n" : index === 2 ? "rel=policy>policy.root\n" : "";
      await writeFile(path.join(root, `src/part${index}.js`),
        `/* llmnav/1 module\nid=${id}\nrole=Own workUnit policy boundary.\n${relation}stability=contract\n*/\n` +
        `export function workUnit() { return \`${"가😀".repeat(2500)}\`; }\r\n`);
    }
    if (task === "source-budget") {
      await check("API bounds and Unicode aggregate", async () => {
        for (const sourceBudget of [256, 257, 4000, 16000]) {
          const result = await discoverProject(root, "workUnit", { includeSource: true, sourceBudget, top: 3 });
          assert.ok(bytes(result) > 0 && bytes(result) <= sourceBudget);
          assert.ok(result.results.every(item => !item.sourceExcerpt?.text.includes("\ufffd")));
        }
      });
      await check("API rejects nearest invalid budgets", async () => {
        for (const sourceBudget of [0, 255, 16001, 256.5]) await assert.rejects(discoverProject(root, "workUnit", { sourceBudget }));
      });
      await check("default and ranking preserved", async () => {
        const plain = await discoverProject(root, "workUnit", { top: 3 });
        const enriched = await discoverProject(root, "workUnit", { top: 3, includeSource: true });
        assert.deepEqual(enriched.results.map(({ sourceExcerpt, ...item }) => item), plain.results);
        assert.ok(bytes(enriched) > 256 && bytes(enriched) <= 4000);
      });
      await check("schema and operation limits", async () => {
        const property = getAgentToolDefinitions().find(item => item.name === "llmnav_discover").inputSchema.properties.sourceBudget;
        assert.equal(property.minimum, 256); assert.equal(property.maximum, 16000); assert.equal(property.default, 4000);
        assert.equal((await executeAgentOperation(root, "llmnav_discover", { task: "workUnit", sourceBudget: 255 })).ok, false);
        const result = await executeAgentOperation(root, "llmnav_discover", { task: "workUnit", includeSource: true, sourceBudget: 256 });
        assert.equal(result.ok, true); assert.ok(bytes(result.data) <= 256);
      });
      await check("CLI forwards and rejects budgets", async () => {
        const valid = cli(["discover", "workUnit", "--include-source", "--source-budget", "256"]);
        assert.equal(valid.status, 0); assert.ok(bytes(JSON.parse(valid.stdout)) <= 256);
        assert.notEqual(cli(["discover", "workUnit", "--source-budget", "255"]).status, 0);
      });
      await check("cancellation remains observable", async () => {
        const signal = AbortSignal.abort(new Error("cancelled"));
        await assert.rejects(discoverProject(root, "workUnit", { signal }));
      });
    } else if (task === "zero-edge-cap") {
      assert.equal((await generateProject(root)).ok, true);
      for (const graph of [true, false]) {
        if (!graph) await rm(path.join(root, ".llmnav/cache/graph.json"));
        const session = await createProjectSession(root);
        for (const maxEdges of [0, 1, 24]) {
          await check(`${graph ? "graph" : "legacy"} cap ${maxEdges}`, async () => {
            const expected = await buildContext(root, "policy.root", { maxEdges, depth: 1, budget: 4000 });
            if (maxEdges === 0) assert.deepEqual(expected.included, ["policy.root"]);
            else assert.ok(expected.included.length > 1);
            for (const options of [{}, { session }]) {
              const actual = await executeAgentOperation(root, "llmnav_context", { id: "policy.root", maxEdges, depth: 1, budget: 4000 }, options);
              assert.equal(actual.ok, true); assert.deepEqual(actual.data, expected);
            }
            const actual = cli(["context", "policy.root", "--max-edges", String(maxEdges), "--budget", "4000"]);
            assert.equal(actual.status, 0); assert.deepEqual(JSON.parse(actual.stdout), expected);
          });
        }
        await check(`${graph ? "graph" : "legacy"} defaults and rejection`, async () => {
          const result = await executeAgentOperation(root, "llmnav_context", { id: "policy.root" });
          assert.equal(result.ok, true);
          assert.deepEqual(result.data, await buildContext(root, "policy.root", { maxEdges: 24 }));
          assert.equal((await executeAgentOperation(root, "llmnav_context", { id: "policy.root", maxEdges: -1 })).ok, false);
          assert.notEqual(cli(["context", "policy.root", "--max-edges", "invalid"]).status, 0);
        });
      }
    } else throw new Error("Unknown policy task.");
    return { passed: checks.length > 0 && checks.every(item => item.passed), checks };
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runPolicyOracle(path.resolve(process.argv[2]), process.argv[3]))); }
  catch (error) { console.log(JSON.stringify({ passed: false, setupFailure: true, error: error.code ?? error.name })); process.exitCode = 1; }
}
