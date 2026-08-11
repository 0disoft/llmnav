/* llmnav/1 module
id=llmnav.structure.boundaries
role=Detect durable artifact, route, event, schema, migration, runtime, and command boundaries from generated local evidence.
owns=boundary kinds|confidence assignment|boundary evidence
excludes=framework execution|source annotations
search=boundary detection|artifact route schema migration|command event runtime
rel=workflow>llmnav.index.generate
stability=architecture
*/

import path from "node:path";
import { compareText, toPosix } from "./util.js";

export const BOUNDARY_KINDS = Object.freeze(["artifact", "command", "event", "migration", "route", "runtime", "schema"]);

export function detectBoundaries(record) {
  const relativePath = toPosix(record.relativePath).toLowerCase();
  const basename = path.posix.basename(relativePath);
  const effects = record.card.effect ?? [];
  const risks = record.card.risk ?? [];
  const source = record.source ?? "";
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
  if (/\bschemaVersion\s*:\s*["'][^"'\r\n]+\/v\d+(?:\.\d+)*["']/u.test(source)) {
    add("schema", "high", "versioned-schema-literal");
  }
  if (/\bexport\s+(?:async\s+)?function\s+[A-Za-z_$][\w$]*FileName\b/u.test(source) &&
      /["'`][^"'`\r\n]*\.[a-z0-9-]+\.json["'`]/iu.test(source)) {
    add("artifact", "medium", "persistent-json-filename");
  }
  if (risks.includes("migration") || /(?:^|\/)(?:migrations?|migrate)(?:\/|$)/u.test(relativePath)) {
    add("migration", "high", risks.includes("migration") ? "risk" : "path");
  }
  if (/(?:^|\/)(?:commands?|cli|bin)(?:\/|$)/u.test(relativePath) || /(?:command|cmd)\.[^.]+$/u.test(basename)) {
    add("command", "high", "path");
  }
  if (/\.rs$/u.test(relativePath) && /#\[tauri::command\]|tauri::generate_handler!/u.test(source)) {
    add("command", "high", "tauri-command");
  }
  if (/\.[cm]?[jt]sx?$/u.test(relativePath) &&
      /\bgetTauriInvoke\s*\(/u.test(source) &&
      /\binvoke(?:\s*<[^;\r\n]+?>)?\s*\(/u.test(source)) {
    add("command", "high", "tauri-invoke");
  }
  if (/\.rs$/u.test(relativePath) &&
      /#\[cfg\((?:windows|unix|target_(?:os|family))/u.test(source) &&
      /\b(?:Drop|shutdown|terminate|kill|process_group|job_object)\b/iu.test(source)) {
    add("runtime", "medium", "platform-lifecycle");
  }

  return [...boundaries.values()].sort((left, right) => compareText(left.kind, right.kind));
}
