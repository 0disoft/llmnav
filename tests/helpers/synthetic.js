import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG } from "../../src/spec.js";
import { stableStringify } from "../../src/util.js";

export function buildSyntheticIndex(cardCount = 5000) {
  const cards = [];
  for (let index = 0; index < cardCount; index += 1) cards.push(syntheticIndexedCard(index));
  return {
    schemaVersion: 1,
    specVersion: "1",
    generatedBy: "synthetic",
    repositoryId: "synthetic",
    sourceHash: "synthetic",
    cards,
  };
}

export function syntheticQueries(cardCount, queryCount = 100) {
  const output = [];
  const step = Math.max(1, Math.floor(cardCount / queryCount));
  for (let index = 0; index < cardCount && output.length < queryCount; index += step) {
    output.push({
      query: `locate operation code${pad(index)} for shard${pad(index)}`,
      expected: syntheticId(index),
    });
  }
  return output;
}

export async function createSyntheticProject(root, options = {}) {
  const fileCount = options.fileCount ?? 100;
  const cardsPerFile = options.cardsPerFile ?? 5;
  const relationsPerCard = options.relationsPerCard ?? 0;
  if (!Number.isInteger(relationsPerCard) || relationsPerCard < 0 || relationsPerCard > 6) {
    throw new Error("relationsPerCard must be an integer from 0 to 6.");
  }
  await mkdir(path.join(root, ".llmnav", "eval"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "synthetic-project", type: "module" }, null, 2)}\n`);

  const config = structuredClone(DEFAULT_CONFIG);
  config.repositoryId = "synthetic-project";
  config.sourceRoots = ["src"];
  config.lint.maxSemanticRatio = 1;
  config.lint.searchTermSaturation = 1;
  config.lint.minimumCardsForSaturation = 1000000;
  await writeFile(path.join(root, ".llmnav", "config.json"), stableStringify(config));
  await writeFile(path.join(root, ".llmnav", "ids.jsonl"), "");
  await writeFile(path.join(root, ".llmnav", "order.lock"), "");
  await writeFile(path.join(root, ".llmnav", "lexicon.json"), '{"version":1,"aliases":{}}\n');
  await writeFile(path.join(root, ".llmnav", "eval", "queries.jsonl"), "");

  const fileIndexes = Array.from({ length: fileCount }, (_, index) => index);
  if (options.fileOrder === "reverse") fileIndexes.reverse();
  else if (Array.isArray(options.fileOrder)) {
    if (options.fileOrder.length !== fileCount) throw new Error("fileOrder must contain every synthetic file index.");
    fileIndexes.splice(0, fileIndexes.length, ...options.fileOrder);
  }

  const writes = [];
  for (const fileIndex of fileIndexes) {
    const start = fileIndex * cardsPerFile;
    const source = [];
    for (let offset = 0; offset < cardsPerFile; offset += 1) {
      const cardIndex = start + offset;
      source.push(renderSourceCard(cardIndex, fileCount * cardsPerFile, relationsPerCard));
    }
    writes.push(writeFile(path.join(root, "src", `fixture-${pad(fileIndex)}.ts`), `${source.join("\n")}\n`));
    if (writes.length >= 64) {
      await Promise.all(writes.splice(0));
    }
  }
  await Promise.all(writes);
  return { fileCount, cardsPerFile, cardCount: fileCount * cardsPerFile };
}

export async function changeSyntheticCard(root, fileIndex, cardOffset, replacement = {}) {
  const filePath = path.join(root, "src", `fixture-${pad(fileIndex)}.ts`);
  const source = await readFile(filePath, "utf8");
  const cardIndex = fileIndex * 5 + cardOffset;
  const oldRole = syntheticRole(cardIndex);
  const newRole = replacement.role ?? `${oldRole.slice(0, -1)} with strict replay protection.`;
  const updated = source.replace(`role=${oldRole}`, `role=${newRole}`);
  if (updated === source) throw new Error(`Synthetic role ${oldRole} was not found in ${filePath}.`);
  await writeFile(filePath, updated);
  return { filePath, cardIndex, id: syntheticId(cardIndex) };
}

export function syntheticId(index) {
  const domain = Math.floor(index / 1000);
  const feature = Math.floor(index / 10) % 100;
  return `domain${pad(domain, 3)}.feature${pad(feature, 3)}.action${pad(index)}`;
}

function syntheticIndexedCard(index) {
  const id = syntheticId(index);
  return {
    scope: "symbol",
    id,
    role: syntheticRole(index),
    owns: [`operation code${pad(index)}`],
    excludes: [],
    search: [`operation code${pad(index)}`, `tenant shard${pad(index)}`],
    invariant: [`Operation code${pad(index)} is applied at most once.`],
    effect: [],
    risk: index % 7 === 0 ? ["concurrency"] : [],
    rel: [],
    stability: "contract",
    location: {
      path: `src/domain${pad(Math.floor(index / 1000), 3)}/action-${pad(index)}.ts`,
      startLine: 1,
      endLine: 9,
      symbol: `operation${pad(index)}`,
      kind: "function",
      declarationLine: 10,
      signature: `export function operation${pad(index)}(): number`,
    },
    imports: [],
    hashes: {
      semantic: `semantic-${pad(index)}`,
      structure: `structure-${pad(index)}`,
      body: `body-${pad(index)}`,
    },
  };
}

function renderSourceCard(index, cardCount, relationsPerCard) {
  const relations = Array.from({ length: Math.min(relationsPerCard, Math.max(0, cardCount - 1)) },
    (_, offset) => `rel=workflow>${syntheticId((index + offset + 1) % cardCount)}\n`).sort().join("");
  return `/* llmnav/1 symbol
id=${syntheticId(index)}
role=${syntheticRole(index)}
owns=operation code${pad(index)}
search=operation code${pad(index)}|tenant shard${pad(index)}
invariant=Operation code${pad(index)} is applied at most once.
${relations}stability=contract
*/
export function operation${pad(index)}(): number { return ${index}; }`;
}

function syntheticRole(index) {
  return `Execute operation code${pad(index)} for tenant shard${pad(index)}.`;
}

function pad(value, width = 6) {
  return String(value).padStart(width, "0");
}
