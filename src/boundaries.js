/* llmnav/1 module
id=llmnav.structure.boundaries
role=Detect route, event, schema, migration, and command boundaries from generated local evidence.
owns=boundary kinds|confidence assignment|boundary evidence
excludes=framework execution|source annotations
search=boundary detection|route schema migration|command event
rel=workflow>llmnav.index.generate
stability=architecture
*/

import path from "node:path";
import { compareText, toPosix } from "./util.js";

export const BOUNDARY_KINDS = Object.freeze(["command", "event", "migration", "route", "schema"]);

export function detectBoundaries(record) {
  const relativePath = toPosix(record.relativePath).toLowerCase();
  const basename = path.posix.basename(relativePath);
  const effects = record.card.effect ?? [];
  const risks = record.card.risk ?? [];
  const boundaries = new Map();
  const add = (kind, confidence, evidence) => {
    const current = boundaries.get(kind);
    const evidences = new Set([...(current?.evidence ?? []), evidence]);
    boundaries.set(kind, {
      kind,
      confidence: current?.confidence === "high" || confidence === "high" ? "high" : "medium",
      evidence: [...evidences].sort(compareText),
    });
  };

  if (/(?:^|\/)(?:routes?|api)(?:\/|$)/u.test(relativePath) || /(?:^|\/)route\.[^.]+$/u.test(relativePath)) {
    add("route", "high", "path");
  }
  if (effects.some((effect) => /^event\.(?:emit|consume)\(/u.test(effect))) add("event", "high", "effect");
  else if (/(?:^|\/)(?:events?|consumers?)(?:\/|$)/u.test(relativePath)) add("event", "medium", "path");

  if (/(?:^|\/)(?:schemas?|contracts?)(?:\/|$)/u.test(relativePath) ||
      /(?:schema\.(?:json|ya?ml)|\.(?:proto|graphql|gql))$/u.test(relativePath)) {
    add("schema", "high", "path");
  }
  if (risks.includes("migration") || /(?:^|\/)(?:migrations?|migrate)(?:\/|$)/u.test(relativePath)) {
    add("migration", "high", risks.includes("migration") ? "risk" : "path");
  }
  if (/(?:^|\/)(?:commands?|cli|bin)(?:\/|$)/u.test(relativePath) || /(?:command|cmd)\.[^.]+$/u.test(basename)) {
    add("command", "high", "path");
  }

  return [...boundaries.values()].sort((left, right) => compareText(left.kind, right.kind));
}
