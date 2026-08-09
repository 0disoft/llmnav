/* llmnav/1 module
id=llmnav.contract.fingerprint
role=Fingerprint repository API and configuration contracts without coupling them to source locations.
owns=contract fingerprint schema|export selection|contract drift comparison
excludes=semantic version decisions|source mutation
search=API fingerprint|configuration fingerprint|contract drift
rel=workflow>llmnav.index.generate
stability=architecture
*/

import path from "node:path";
import { compareText, sha256, stableJson } from "./util.js";

export const CONTRACT_FINGERPRINT_SCHEMA_VERSION = 1;

export function buildContractFingerprints(project, cards) {
  const exportedApi = cards
    .filter(isExportedApiCard)
    .map((card) => ({
      id: card.id,
      kind: card.location.kind,
      symbol: card.location.symbol,
      signature: card.location.signature,
    }))
    .sort((left, right) => compareText(left.id, right.id));
  const { $schema: _schemaLocation, ...effectiveConfig } = project.config;

  return {
    schemaVersion: CONTRACT_FINGERPRINT_SCHEMA_VERSION,
    exportedApi: {
      count: exportedApi.length,
      sha256: sha256(stableJson(exportedApi)),
    },
    configuration: {
      sha256: sha256(stableJson(effectiveConfig)),
    },
  };
}

export function compareContractFingerprints(previous, current) {
  if (previous?.schemaVersion !== CONTRACT_FINGERPRINT_SCHEMA_VERSION) return [];
  if (current?.schemaVersion !== CONTRACT_FINGERPRINT_SCHEMA_VERSION) return [];

  const changes = [];
  for (const kind of ["exportedApi", "configuration"]) {
    if (previous[kind]?.sha256 === current[kind]?.sha256) continue;
    changes.push({
      kind,
      previous: previous[kind]?.sha256 ?? null,
      current: current[kind]?.sha256 ?? null,
    });
  }
  return changes;
}

function isExportedApiCard(card) {
  const location = card.location;
  if (!location?.symbol || !location.signature) return false;
  if (typeof location.exported === "boolean") return location.exported;
  const extension = path.extname(location.path).toLowerCase();
  const signature = location.signature.trim();

  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extension)) {
    return /^(?:export\s+(?:default\s+)?)/u.test(signature);
  }
  if (extension === ".go") return /^[A-Z]/u.test(location.symbol);
  if (extension === ".rs") return /^pub(?:\([^)]*\))?\s+/u.test(signature);
  if (extension === ".py") return !location.symbol.startsWith("_");
  return /^(?:public|export)\s+/u.test(signature);
}
