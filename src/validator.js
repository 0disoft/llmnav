/* llmnav/1 module
id=llmnav.rules.validate
role=Reject unstable, ambiguous, oversized, or structurally invalid LLMNav metadata before indexing.
owns=semantic lint rules|coverage rules|registry consistency
excludes=source rewriting|search ranking
search=llmnav lint|metadata validation|semantic drift
rel=workflow>llmnav.syntax.parse
stability=architecture
*/

import path from "node:path";
import {
  ALLOWED_KEYS,
  CROSS_REPO_ID_PATTERN,
  EFFECT_KINDS,
  EFFECT_KINDS_WITH_ARGUMENT,
  EFFECT_KINDS_WITHOUT_ARGUMENT,
  FORBIDDEN_STRUCTURE_RELATIONS,
  FORBIDDEN_VOLATILE_KEYS,
  ID_PATTERN,
  KEY_ORDER,
  LIST_KEYS,
  RELATION_KINDS,
  REPEATABLE_KEYS,
  REQUIRED_KEYS,
  RISK_KINDS,
  SCOPES,
  STABILITIES,
} from "./spec.js";
import { formatLlmnavBlock } from "./parser.js";
import { resolveRegistryId } from "./registry.js";
import { matchesAnyGlob, unique } from "./util.js";

export function validateProject(project) {
  const diagnostics = [];
  const idRecords = new Map();

  for (const error of project.registry.errors) {
    diagnostics.push(diagnostic("error", "LNV002", error, ".llmnav/ids.jsonl", 1));
  }

  for (const record of project.records) {
    const local = validateRecord(record, project.config);
    diagnostics.push(...local);
    if (record.card.id) {
      const existing = idRecords.get(record.card.id);
      if (existing) {
        diagnostics.push(
          diagnostic(
            "error",
            "LNV002",
            `Duplicate semantic ID ${record.card.id}; first declared in ${existing.relativePath}:${existing.block.startLine}.`,
            record.relativePath,
            record.block.startLine,
          ),
        );
      } else {
        idRecords.set(record.card.id, record);
      }
    }
  }

  validateRelations(project, idRecords, diagnostics);
  validateRegistry(project, idRecords, diagnostics);
  validateCoverage(project, diagnostics);
  validateSearchSaturation(project, diagnostics);
  validateSemanticRatio(project, diagnostics);

  diagnostics.sort(compareDiagnostics);
  return diagnostics;
}

function validateRecord(record, config) {
  const diagnostics = [];
  const { block, card, relativePath, declaration } = record;
  for (const syntaxError of block.syntaxErrors) {
    diagnostics.push(diagnostic("error", "LNV011", syntaxError.message, relativePath, syntaxError.line));
  }

  if (!SCOPES.includes(block.scope)) {
    diagnostics.push(diagnostic("error", "LNV011", `Unknown scope ${block.scope}.`, relativePath, block.startLine));
  }

  for (const unknown of card.unknown) {
    const code = FORBIDDEN_VOLATILE_KEYS.includes(unknown.key) ? "LNV003" : "LNV005";
    const message =
      code === "LNV003"
        ? `Volatile or generated field ${unknown.key} is forbidden in source comments.`
        : `Unknown field ${unknown.key}; allowed fields are ${ALLOWED_KEYS.join(", ")}.`;
    diagnostics.push(diagnostic("error", code, message, relativePath, unknown.line));
  }

  const presentKeys = new Set(block.entries.map((entry) => entry.key));
  for (const entry of block.entries) {
    if (!entry.value.trim()) {
      diagnostics.push(
        diagnostic("error", "LNV005", `Field ${entry.key} must not be empty.`, relativePath, entry.line),
      );
    }
    if (LIST_KEYS.includes(entry.key)) {
      const items = entry.value.split("|");
      if (items.some((item) => !item.trim())) {
        diagnostics.push(
          diagnostic("error", "LNV005", `Field ${entry.key} contains an empty list item.`, relativePath, entry.line),
        );
      }
    }
  }

  for (const key of REQUIRED_KEYS) {
    if (!presentKeys.has(key)) {
      diagnostics.push(diagnostic("error", "LNV001", `Missing required field ${key}.`, relativePath, block.startLine));
    }
  }

  const counts = new Map();
  for (const entry of block.entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  for (const key of ["id", "role", "owns", "excludes", "search", "effect", "risk", "stability"]) {
    if ((counts.get(key) ?? 0) > 1) {
      diagnostics.push(
        diagnostic("error", "LNV005", `${key} must appear once; combine list values with |.`, relativePath, block.startLine),
      );
    }
  }

  if (card.id && !ID_PATTERN.test(card.id)) {
    diagnostics.push(
      diagnostic(
        "error",
        "LNV002",
        `Invalid ID ${card.id}; use lower-case dot segments such as auth.session.rotate.`,
        relativePath,
        lineFor(block, "id"),
      ),
    );
  }

  validateDuplicateValues(record, diagnostics);
  validateRole(record, config, diagnostics);
  validateSearch(record, config, diagnostics);
  validateInvariants(record, config, diagnostics);
  validateEffects(record, config, diagnostics);
  validateRisks(record, config, diagnostics);
  validateRelationsForRecord(record, config, diagnostics);

  if (card.stability && !STABILITIES.includes(card.stability)) {
    diagnostics.push(
      diagnostic(
        "error",
        "LNV005",
        `Unknown stability ${card.stability}; expected ${STABILITIES.join(", ")}.`,
        relativePath,
        lineFor(block, "stability"),
      ),
    );
  }

  const limit = config.lint.maxBlockBytes[block.scope];
  const bytes = Buffer.byteLength(block.raw);
  if (limit && bytes > limit) {
    diagnostics.push(
      diagnostic("error", "LNV013", `${block.scope} block is ${bytes} bytes; limit is ${limit}.`, relativePath, block.startLine),
    );
  }

  if (block.scope === "symbol" && !declaration) {
    diagnostics.push(
      diagnostic(
        "error",
        "LNV011",
        "Symbol card is not attached to a recognized declaration within the next 3,000 characters.",
        relativePath,
        block.endLine,
      ),
    );
  }

  if (config.lint.requireCanonicalOrder) {
    const positions = block.entries
      .filter((entry) => KEY_ORDER.includes(entry.key))
      .map((entry) => KEY_ORDER.indexOf(entry.key));
    if (positions.some((position, index) => index > 0 && position < positions[index - 1])) {
      diagnostics.push(
        diagnostic("error", "LNV010", "Fields are not in canonical order; run llmnav format.", relativePath, block.startLine),
      );
    }
  }

  if (config.lint.requireCanonicalFormatting) {
    const expected = formatLlmnavBlock(block).trim();
    if (block.raw.trim() !== expected) {
      diagnostics.push(
        diagnostic("error", "LNV010", "Block is not canonically formatted; run llmnav format.", relativePath, block.startLine),
      );
    }
  }

  return diagnostics;
}


function validateDuplicateValues(record, diagnostics) {
  const { card, block, relativePath } = record;
  for (const key of [...LIST_KEYS, ...REPEATABLE_KEYS]) {
    const values = card[key] ?? [];
    const normalized = values.map(normalizePhrase);
    if (unique(normalized).length === normalized.length) continue;
    const code = key === "search" ? "LNV007" : "LNV005";
    diagnostics.push(
      diagnostic("error", code, `${key} contains duplicate values.`, relativePath, lineFor(block, key)),
    );
  }
}

function validateRole(record, config, diagnostics) {
  const { card, block, relativePath } = record;
  if (!card.role) return;
  if (card.role.length > config.lint.maxRoleLength) {
    diagnostics.push(
      diagnostic(
        "error",
        "LNV006",
        `role is ${card.role.length} characters; limit is ${config.lint.maxRoleLength}.`,
        relativePath,
        lineFor(block, "role"),
      ),
    );
  }
  const words = tokenize(card.role);
  if (words.length <= 5 && config.lint.vagueRoleWords.some((word) => words.includes(word.toLowerCase()))) {
    diagnostics.push(
      diagnostic(
        "warning",
        "LNV006",
        "role is vague; describe the observable result instead of using handle, manage, process, service, helper, or utility.",
        relativePath,
        lineFor(block, "role"),
      ),
    );
  }
  if (looksVolatile(card.role)) {
    diagnostics.push(
      diagnostic("error", "LNV003", "role contains path, line, commit, or timestamp-like volatile data.", relativePath, lineFor(block, "role")),
    );
  }
}

function validateSearch(record, config, diagnostics) {
  const { card, block, relativePath } = record;
  if (card.search.length === 0) return;
  if (card.search.length < config.lint.minSearchTerms || card.search.length > config.lint.maxSearchTerms) {
    diagnostics.push(
      diagnostic(
        "error",
        "LNV007",
        `search requires ${config.lint.minSearchTerms} to ${config.lint.maxSearchTerms} phrases; found ${card.search.length}.`,
        relativePath,
        lineFor(block, "search"),
      ),
    );
  }
  const normalized = card.search.map(normalizePhrase);
  const generic = new Set(config.lint.genericSearchTerms.map(normalizePhrase));
  for (const phrase of normalized) {
    if (generic.has(phrase)) {
      diagnostics.push(
        diagnostic("error", "LNV007", `Generic search phrase ${JSON.stringify(phrase)} is forbidden.`, relativePath, lineFor(block, "search")),
      );
    }
  }
  if (card.search.some(looksVolatile)) {
    diagnostics.push(
      diagnostic("error", "LNV003", "search contains path, line, commit, or timestamp-like volatile data.", relativePath, lineFor(block, "search")),
    );
  }
}

function validateInvariants(record, config, diagnostics) {
  const { card, block, relativePath } = record;
  if (card.invariant.length > config.lint.maxInvariants) {
    diagnostics.push(
      diagnostic(
        "error",
        "LNV013",
        `Too many invariants; maximum is ${config.lint.maxInvariants}.`,
        relativePath,
        lineFor(block, "invariant"),
      ),
    );
  }
  if (card.invariant.some(looksVolatile)) {
    diagnostics.push(
      diagnostic("error", "LNV003", "invariant contains volatile location or revision data.", relativePath, lineFor(block, "invariant")),
    );
  }
}

function validateEffects(record, config, diagnostics) {
  const { card, block, relativePath } = record;
  if (card.effect.length > config.lint.maxEffects) {
    diagnostics.push(
      diagnostic("error", "LNV013", `Too many effects; maximum is ${config.lint.maxEffects}.`, relativePath, lineFor(block, "effect")),
    );
  }
  const allowed = new Set([...EFFECT_KINDS, ...config.lint.additionalEffects]);
  const requiresArgument = new Set(EFFECT_KINDS_WITH_ARGUMENT);
  const forbidsArgument = new Set(EFFECT_KINDS_WITHOUT_ARGUMENT);
  for (const effect of card.effect) {
    const match = effect.match(/^([a-z][a-z0-9.-]*)(?:\(([A-Za-z0-9_.:/-]+)\))?$/u);
    if (!match || !allowed.has(match[1])) {
      diagnostics.push(
        diagnostic(
          "error",
          "LNV005",
          `Invalid effect ${effect}; use a controlled effect such as db.write(session_tokens).`,
          relativePath,
          lineFor(block, "effect"),
        ),
      );
      continue;
    }
    const [, kind, argument] = match;
    if (requiresArgument.has(kind) && !argument) {
      diagnostics.push(
        diagnostic(
          "error",
          "LNV005",
          `Effect ${kind} requires one stable target argument, for example ${kind}(resource_name).`,
          relativePath,
          lineFor(block, "effect"),
        ),
      );
    } else if (forbidsArgument.has(kind) && argument) {
      diagnostics.push(
        diagnostic(
          "error",
          "LNV005",
          `Effect ${kind} does not accept an argument.`,
          relativePath,
          lineFor(block, "effect"),
        ),
      );
    }
  }
}

function validateRisks(record, config, diagnostics) {
  const { card, block, relativePath } = record;
  const allowed = new Set([...RISK_KINDS, ...config.lint.additionalRisks]);
  for (const risk of card.risk) {
    if (!allowed.has(risk)) {
      diagnostics.push(diagnostic("error", "LNV005", `Unknown risk ${risk}.`, relativePath, lineFor(block, "risk")));
    }
  }
  const strict = card.risk.some((risk) => config.lint.strictRisks.includes(risk));
  if (strict && card.invariant.length === 0) {
    diagnostics.push(
      diagnostic("error", "LNV001", "auth, money, and privacy cards require at least one invariant.", relativePath, block.startLine),
    );
  }
  if (strict && !card.rel.some((relation) => relation.startsWith("test>"))) {
    diagnostics.push(
      diagnostic("error", "LNV001", "auth, money, and privacy cards require a rel=test>… contract link.", relativePath, block.startLine),
    );
  }
}

function validateRelationsForRecord(record, config, diagnostics) {
  const { card, block, relativePath } = record;
  if (card.rel.length > config.lint.maxRelations) {
    diagnostics.push(
      diagnostic("error", "LNV013", `Too many relations; maximum is ${config.lint.maxRelations}.`, relativePath, lineFor(block, "rel")),
    );
  }
  const allowed = new Set([...RELATION_KINDS, ...config.lint.additionalRelations]);
  for (const relation of card.rel) {
    const separator = relation.indexOf(">");
    if (separator <= 0) {
      diagnostics.push(
        diagnostic("error", "LNV005", `Invalid relation ${relation}; use type>semantic.id.`, relativePath, lineFor(block, "rel")),
      );
      continue;
    }
    const type = relation.slice(0, separator);
    const target = relation.slice(separator + 1);
    if (FORBIDDEN_STRUCTURE_RELATIONS.includes(type)) {
      diagnostics.push(
        diagnostic(
          "error",
          "LNV004",
          `Relation ${type} is generated structure and must not be maintained by hand.`,
          relativePath,
          lineFor(block, "rel"),
        ),
      );
      continue;
    }
    if (!allowed.has(type)) {
      diagnostics.push(diagnostic("error", "LNV005", `Unknown relation type ${type}.`, relativePath, lineFor(block, "rel")));
    }
    const validTarget = type === "cross-repo" ? CROSS_REPO_ID_PATTERN.test(target) : ID_PATTERN.test(target);
    if (!validTarget) {
      diagnostics.push(diagnostic("error", "LNV005", `Invalid relation target ${target}.`, relativePath, lineFor(block, "rel")));
    }
  }
}

function validateRelations(project, idRecords, diagnostics) {
  for (const record of project.records) {
    for (const relation of record.card.rel) {
      const separator = relation.indexOf(">");
      if (separator <= 0) continue;
      const type = relation.slice(0, separator);
      const target = relation.slice(separator + 1);
      if (type === "cross-repo") continue;
      if (!idRecords.has(target) && !project.registry.byId.has(target)) {
        diagnostics.push(
          diagnostic(
            "error",
            "LNV008",
            `Relation target ${target} does not exist in source or .llmnav/ids.jsonl.`,
            record.relativePath,
            lineFor(record.block, "rel"),
          ),
        );
        continue;
      }
      const registryTarget = project.registry.byId.get(target);
      if (registryTarget && registryTarget.state !== "active") {
        const resolved = resolveRegistryId(project.registry, target);
        if (resolved.state !== "active") {
          diagnostics.push(
            diagnostic(
              "error",
              "LNV008",
              `Relation target ${target} resolves to ${resolved.state}, not an active semantic ID.`,
              record.relativePath,
              lineFor(record.block, "rel"),
            ),
          );
        }
      }
    }
  }
}

function validateRegistry(project, idRecords, diagnostics) {
  for (const [id, record] of idRecords) {
    const registryRecord = project.registry.byId.get(id);
    if (registryRecord && registryRecord.state !== "active") {
      diagnostics.push(
        diagnostic(
          "error",
          "LNV002",
          `Source uses registry ID ${id}, but its state is ${registryRecord.state}.`,
          record.relativePath,
          record.block.startLine,
        ),
      );
    }
  }
  for (const registryRecord of project.registry.records) {
    const targets = registryRecord.state === "redirect"
      ? [registryRecord.to]
      : registryRecord.state === "replaced" && Array.isArray(registryRecord.by)
        ? registryRecord.by
        : [];
    for (const target of targets.filter(Boolean)) {
      if (!idRecords.has(target) && !project.registry.byId.has(target)) {
        diagnostics.push(
          diagnostic(
            "error",
            "LNV002",
            `Registry ID ${registryRecord.id} points to missing semantic ID ${target}.`,
            ".llmnav/ids.jsonl",
            1,
          ),
        );
      }
    }
    if (registryRecord.state === "redirect" || registryRecord.state === "replaced") {
      const resolved = resolveRegistryId(project.registry, registryRecord.id);
      if (resolved.state === "cycle") {
        diagnostics.push(
          diagnostic(
            "error",
            "LNV002",
            `Registry ID ${registryRecord.id} participates in a redirect or replacement cycle.`,
            ".llmnav/ids.jsonl",
            1,
          ),
        );
      }
    }
    if (registryRecord.state === "active" && !idRecords.has(registryRecord.id)) {
      diagnostics.push(
        diagnostic(
          "warning",
          "LNV012",
          `Registry ID ${registryRecord.id} is active but has no source card; mark it redirect, replaced, or retired if deleted.`,
          ".llmnav/ids.jsonl",
          1,
        ),
      );
    }
  }
}

function validateCoverage(project, diagnostics) {
  for (const rule of project.config.coverageRules) {
    if (!rule || typeof rule !== "object" || !Array.isArray(rule.match)) continue;
    for (const file of project.fileRecords) {
      if (!matchesAnyGlob(file.relativePath, rule.match)) continue;
      const cards = file.blocks.filter((block) => !rule.scope || block.scope === rule.scope);
      if (cards.length === 0) {
        diagnostics.push(
          diagnostic(
            "error",
            "LNV001",
            `Coverage rule ${JSON.stringify(rule.name ?? rule.match.join(", "))} requires a ${rule.scope ?? "LLMNav"} card.`,
            file.relativePath,
            1,
          ),
        );
        continue;
      }
      for (const field of rule.requiredFields ?? []) {
        if (!cards.some((block) => hasValue(block.card[field]))) {
          diagnostics.push(
            diagnostic(
              "error",
              "LNV001",
              `Coverage rule ${JSON.stringify(rule.name ?? "unnamed")} requires field ${field}.`,
              file.relativePath,
              cards[0].startLine,
            ),
          );
        }
      }
    }
  }
}

function validateSearchSaturation(project, diagnostics) {
  const cards = project.records.filter((record) => record.card.id);
  if (cards.length < project.config.lint.minimumCardsForSaturation) return;
  const counts = new Map();
  for (const record of cards) {
    for (const phrase of new Set(record.card.search.map(normalizePhrase))) {
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  for (const [phrase, count] of counts) {
    const ratio = count / cards.length;
    if (ratio > project.config.lint.searchTermSaturation) {
      diagnostics.push(
        diagnostic(
          "warning",
          "LNV007",
          `Search phrase ${JSON.stringify(phrase)} appears in ${(ratio * 100).toFixed(1)}% of cards; limit is ${(project.config.lint.searchTermSaturation * 100).toFixed(1)}%.`,
          ".llmnav/config.json",
          1,
        ),
      );
    }
  }
}

function validateSemanticRatio(project, diagnostics) {
  if (project.sourceBytes < project.config.lint.minimumSourceBytesForRatio) return;
  const ratio = project.semanticBytes / project.sourceBytes;
  if (ratio > project.config.lint.maxSemanticRatio) {
    diagnostics.push(
      diagnostic(
        "warning",
        "LNV013",
        `LLMNav comments occupy ${(ratio * 100).toFixed(2)}% of scanned source; budget is ${(project.config.lint.maxSemanticRatio * 100).toFixed(2)}%.`,
        ".llmnav/config.json",
        1,
      ),
    );
  }
}

export function diagnostic(severity, code, message, file, line = 1, column = 1) {
  return { severity, code, message, file, line, column };
}

export function countDiagnostics(diagnostics) {
  return diagnostics.reduce(
    (counts, item) => {
      counts[item.severity] = (counts[item.severity] ?? 0) + 1;
      return counts;
    },
    { error: 0, warning: 0, info: 0 },
  );
}

function lineFor(block, key) {
  return block.entries.find((entry) => entry.key === key)?.line ?? block.startLine;
}

function normalizePhrase(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function tokenize(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function looksVolatile(value) {
  return (
    /(?:^|\s)(?:src|app|packages|services|internal|cmd|lib)\/[\w./-]+/u.test(value) ||
    /\bline\s+\d+\b/iu.test(value) ||
    /:\d{1,6}(?:-\d{1,6})?\b/u.test(value) ||
    /\b[0-9a-f]{12,40}\b/iu.test(value) ||
    /\b20\d{2}-\d{2}-\d{2}\b/u.test(value)
  );
}

function hasValue(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function compareDiagnostics(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code)
  );
}
