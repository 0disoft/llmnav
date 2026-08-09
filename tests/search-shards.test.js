import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateProject } from "../src/generator.js";
import { initializeProject } from "../src/initializer.js";
import { buildInvertedIndex, verifySearchIndex } from "../src/inverted-index.js";
import { buildSearchShards } from "../src/search-shards.js";
import { buildSyntheticIndex } from "./helpers/synthetic.js";

test("builds deterministic compatible card-range search shards", () => {
  const index = buildSyntheticIndex(7);
  const searchIndex = buildInvertedIndex(index).searchIndex;
  const first = buildSearchShards(index, searchIndex, 3);
  const second = buildSearchShards(index, searchIndex, 3);

  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual([...second.shards], [...first.shards]);
  assert.equal(first.manifest.shardCount, 3);
  assert.deepEqual(first.manifest.shards.map((item) => item.cardCount), [3, 3, 1]);

  const cardsById = new Map(index.cards.map((card) => [card.id, card]));
  for (const [file, content] of first.shards) {
    const shard = JSON.parse(content);
    const subset = {
      ...index,
      cards: shard.cardIds.map((id) => cardsById.get(id)),
    };
    assert.equal(verifySearchIndex(subset, shard), true, file);
  }
});

test("does not emit shards at or below the configured size", () => {
  const index = buildSyntheticIndex(3);
  const searchIndex = buildInvertedIndex(index).searchIndex;
  assert.deepEqual(buildSearchShards(index, searchIndex, 0), { manifest: null, shards: new Map() });
  assert.deepEqual(buildSearchShards(index, searchIndex, 3), { manifest: null, shards: new Map() });
});

test("generation publishes and removes configured search shards transactionally", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-search-shards-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"search-shard-fixture"}\n');
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "operations.ts"),
    `${card("ops.first", "first operation")}export function first() {}\n${card("ops.second", "second operation")}export function second() {}\n`,
  );
  const initialized = await initializeProject(root, { agents: ["none"] });
  assert.equal(initialized.ok, true);

  const configPath = path.join(root, ".llmnav", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.generation.searchShardSize = 1;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const sharded = await generateProject(root);
  assert.equal(sharded.ok, true);
  const manifest = JSON.parse(await readFile(path.join(root, ".llmnav", "cache", "search-shards.json"), "utf8"));
  assert.equal(manifest.shardCount, 2);
  await access(path.join(root, ".llmnav", "cache", "search-shards", "0000.json"));
  await access(path.join(root, ".llmnav", "cache", "search-shards", "0001.json"));

  config.generation.searchShardSize = 0;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const unsharded = await generateProject(root);
  assert.equal(unsharded.ok, true);
  await assert.rejects(() => access(path.join(root, ".llmnav", "cache", "search-shards.json")), /ENOENT/u);
  await assert.rejects(() => access(path.join(root, ".llmnav", "cache", "search-shards", "0000.json")), /ENOENT/u);
});

function card(id, search) {
  return `/* llmnav/1 symbol\nid=${id}\nrole=Execute ${search} deterministically.\nsearch=${search}|operation contract\nstability=contract\n*/\n`;
}
