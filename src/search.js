/* llmnav/1 module
id=llmnav.search.query
role=Rank semantic cards from task language, aliases, metadata fields, and one-hop semantic relations.
owns=query ranking|multilingual aliases|context expansion
excludes=embedding generation|source mutation
search=semantic code search|agent navigation|multilingual query
rel=workflow>llmnav.index.generate
stability=architecture
*/

import path from "node:path";
import { readJson } from "./util.js";
import { resolveRegistryId, loadRegistry } from "./registry.js";
import { renderCompactCard } from "./generator.js";
import { approximateTokens, truncateToTokenBudget } from "./util.js";

const FIELD_WEIGHTS = Object.freeze({
  id: 12,
  role: 8,
  search: 10,
  owns: 7,
  excludes: 2,
  invariant: 6,
  effect: 5,
  risk: 4,
  symbol: 5,
  path: 3,
  signature: 3,
});

export async function loadSearchData(root) {
  const indexPath = path.join(root, ".llmnav", "cache", "index.json");
  const index = await readJson(indexPath, null);
  if (!index) throw new Error("No generated index found. Run `llmnav generate` first.");
  const lexicon = await readJson(path.join(root, ".llmnav", "lexicon.json"), { version: 1, aliases: {} });
  return { index, lexicon };
}

export async function queryProject(root, query, options = {}) {
  const { index, lexicon } = await loadSearchData(root);
  return queryIndex(index, query, { ...options, lexicon });
}

export function queryIndex(index, query, options = {}) {
  const top = boundedInteger(options.top, 5, 1, 100);
  const lexicon = options.lexicon ?? { aliases: {} };
  const normalizedQuery = normalize(query);
  const queryTokens = tokenize(query);
  const aliases = Object.entries(lexicon.aliases ?? {});
  const aliasTargets = new Set();
  const aliasReasons = new Map();

  for (const [alias, targetValue] of aliases) {
    const normalizedAlias = normalize(alias);
    if (!normalizedAlias || !normalizedQuery.includes(normalizedAlias)) continue;
    const targets = Array.isArray(targetValue) ? targetValue : [targetValue];
    for (const target of targets) {
      aliasTargets.add(target);
      const reasons = aliasReasons.get(target) ?? [];
      reasons.push(`alias=${JSON.stringify(alias)}`);
      aliasReasons.set(target, reasons);
    }
  }

  const documents = index.cards.map((card) => buildDocument(card));
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of new Set(document.allTokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const results = [];
  for (const [cardIndex, card] of index.cards.entries()) {
    const document = documents[cardIndex];
    let score = 0;
    const reasons = [];

    if (normalize(card.id) === normalizedQuery) {
      score += 1000;
      reasons.push("exact semantic ID");
    } else if (normalize(card.id).includes(normalizedQuery) && normalizedQuery.length > 2) {
      score += 100;
      reasons.push("semantic ID phrase");
    }

    if (aliasTargets.has(card.id)) {
      score += 500;
      reasons.push(...(aliasReasons.get(card.id) ?? []));
    }

    for (const token of queryTokens) {
      const frequency = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (index.cards.length + 1) / (frequency + 1));
      let tokenScore = 0;
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        const count = document.fields[field]?.filter((item) => item === token).length ?? 0;
        tokenScore += count * weight * idf;
      }
      if (tokenScore > 0) {
        score += tokenScore;
        reasons.push(`token=${token}`);
      }
    }

    const phraseFields = [card.role, ...(card.search ?? []), ...(card.invariant ?? []), ...(card.owns ?? [])]
      .filter(Boolean)
      .map(normalize);
    if (normalizedQuery.length >= 4 && phraseFields.some((field) => field.includes(normalizedQuery))) {
      score += 40;
      reasons.push("exact phrase");
    }

    if (score > 0) results.push({ card, score, reasons: [...new Set(reasons)].slice(0, 6) });
  }

  const byId = new Map(results.map((result) => [result.card.id, result]));
  const seeds = [...results].sort((left, right) => right.score - left.score).slice(0, 3);
  for (const seed of seeds) {
    for (const relation of seed.card.rel ?? []) {
      const separator = relation.indexOf(">");
      if (separator <= 0) continue;
      const target = relation.slice(separator + 1);
      const targetCard = index.cards.find((card) => card.id === target);
      if (!targetCard) continue;
      const existing = byId.get(target);
      const bonus = seed.score * 0.08;
      if (existing) {
        existing.score += bonus;
        existing.reasons.push(`related-from=${seed.card.id}`);
      } else {
        const result = { card: targetCard, score: bonus, reasons: [`related-from=${seed.card.id}`] };
        results.push(result);
        byId.set(target, result);
      }
    }
  }

  return results
    .sort((left, right) => right.score - left.score || left.card.id.localeCompare(right.card.id))
    .slice(0, top)
    .map((result) => ({
      id: result.card.id,
      score: Number(result.score.toFixed(3)),
      reasons: [...new Set(result.reasons)].slice(0, 6),
      role: result.card.role,
      location: result.card.location,
      card: result.card,
    }));
}

export async function showProjectCard(root, id) {
  const { index } = await loadSearchData(root);
  const direct = index.cards.find((card) => card.id === id);
  if (direct) return { card: direct, resolvedFrom: null };
  const registry = await loadRegistry(root);
  const resolved = resolveRegistryId(registry, id);
  if (resolved.state !== "active") return { card: null, resolvedFrom: resolved };
  return {
    card: index.cards.find((card) => card.id === resolved.id) ?? null,
    resolvedFrom: resolved,
  };
}

export async function buildContext(root, id, options = {}) {
  const { index } = await loadSearchData(root);
  const registry = await loadRegistry(root);
  const direct = index.cards.find((card) => card.id === id);
  const resolved = direct ? { id, state: "active" } : resolveRegistryId(registry, id);
  if (resolved.state !== "active") throw new Error(`Unknown or inactive semantic ID ${id}.`);
  const rootId = resolved.id;
  const depth = boundedInteger(options.depth, 1, 0, 8);
  const budget = boundedInteger(options.budget, 2500, 128, 100000);
  const start = index.cards.find((card) => card.id === rootId);
  if (!start) throw new Error(`No indexed source card exists for semantic ID ${rootId}.`);
  const byId = new Map(index.cards.map((card) => [card.id, card]));
  const reverse = new Map();
  for (const card of index.cards) {
    for (const relation of card.rel ?? []) {
      const target = relation.slice(relation.indexOf(">") + 1);
      const list = reverse.get(target) ?? [];
      list.push(card.id);
      reverse.set(target, list);
    }
  }

  const queue = [{ id: rootId, depth: 0 }];
  const visited = new Set();
  const selected = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    const card = byId.get(current.id);
    if (!card) continue;
    selected.push(card);
    if (current.depth >= depth) continue;
    for (const relation of card.rel ?? []) {
      const target = relation.slice(relation.indexOf(">") + 1);
      queue.push({ id: target, depth: current.depth + 1 });
    }
    for (const source of reverse.get(card.id) ?? []) queue.push({ id: source, depth: current.depth + 1 });
  }

  const header = `llmnav-context/1 root=${rootId} depth=${depth}\n`;
  let output = header;
  const included = [];
  for (const card of selected) {
    const rendered = `${renderCompactCard(card)}\n\n`;
    if (approximateTokens(output + rendered) > budget) {
      if (included.length === 0) {
        output = truncateToTokenBudget(output + rendered, budget);
        included.push(card.id);
      }
      break;
    }
    output += rendered;
    included.push(card.id);
  }
  return {
    id: rootId,
    depth,
    budget,
    included,
    text: truncateToTokenBudget(output.trimEnd(), budget),
  };
}


function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.isInteger(value) ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function buildDocument(card) {
  const fields = {
    id: tokenize(card.id.replaceAll(".", " ")),
    role: tokenize(card.role),
    search: tokenize((card.search ?? []).join(" ")),
    owns: tokenize((card.owns ?? []).join(" ")),
    excludes: tokenize((card.excludes ?? []).join(" ")),
    invariant: tokenize((card.invariant ?? []).join(" ")),
    effect: tokenize((card.effect ?? []).join(" ")),
    risk: tokenize((card.risk ?? []).join(" ")),
    symbol: tokenize(card.location?.symbol ?? ""),
    path: tokenize(card.location?.path ?? ""),
    signature: tokenize(card.location?.signature ?? ""),
  };
  return { fields, allTokens: Object.values(fields).flat() };
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

export function tokenize(value) {
  const normalized = normalize(value);
  const base = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = [...base];
  for (const token of base) {
    if (containsCjk(token) && [...token].length >= 3) {
      const characters = [...token];
      for (let index = 0; index <= characters.length - 2; index += 1) {
        tokens.push(characters.slice(index, index + 2).join(""));
      }
      for (let index = 0; index <= characters.length - 3; index += 1) {
        tokens.push(characters.slice(index, index + 3).join(""));
      }
    }
  }
  return tokens;
}

function containsCjk(value) {
  return /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}
