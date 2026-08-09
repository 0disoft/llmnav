/* llmnav/1 module
id=llmnav.graph.generate
role=Build a deterministic repository graph with qualified nodes, provenance, and confidence.
owns=graph schema|edge normalization|local import resolution
excludes=query scoring|workspace file discovery
search=repository graph|edge provenance|graph confidence
rel=workflow>llmnav.graph.import
rel=workflow>llmnav.index.generate
stability=architecture
*/

import path from "node:path";
import { compareText, sha256, stableJson, stableStringify, toPosix } from "./util.js";

export const GRAPH_SCHEMA_VERSION = 1;
const IMPORT_EXTENSIONS = Object.freeze([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".py"]);

export function buildRepositoryGraph(project, index) {
  const repositoryId = index.repositoryId;
  const nodes = new Map();
  const edges = new Map();
  const cardsByPath = groupCardsByPath(index.cards);

  for (const card of index.cards) {
    const key = qualifyId(card.id, repositoryId);
    mergeNode(nodes, key, {
      role: card.role,
      location: card.location,
      definitions: card.location?.symbol ? [{
        symbol: card.location.symbol,
        path: card.location.path,
        line: card.location.declarationLine,
        kind: card.location.kind,
        provenance: { type: "llmnav-index", source: ".llmnav/cache/index.json", generator: null },
      }] : [],
    }, repositoryId);

    for (const relation of card.rel ?? []) {
      const separator = relation.indexOf(">");
      if (separator <= 0) continue;
      addEdge(edges, nodes, {
        from: key,
        to: qualifyId(relation.slice(separator + 1), repositoryId),
        kind: relation.slice(0, separator),
        confidence: 1,
        provenance: {
          type: "source-card",
          source: card.location.path,
          path: card.location.path,
          line: card.location.startLine,
          generator: null,
        },
      }, repositoryId);
    }

    for (const specifier of card.imports ?? []) {
      for (const target of resolveLocalImport(card.location.path, specifier, cardsByPath)) {
        addEdge(edges, nodes, {
          from: key,
          to: qualifyId(target.id, repositoryId),
          kind: "imports",
          confidence: 0.85,
          provenance: {
            type: "local-import",
            source: card.location.path,
            path: card.location.path,
            line: card.location.declarationLine,
            generator: "llmnav",
          },
        }, repositoryId);
      }
    }
  }

  for (const imported of project.graphInputs ?? []) {
    for (const definition of imported.definitions) {
      mergeNode(nodes, definition.id, {
        definitions: [{
          symbol: definition.symbol,
          path: definition.path,
          line: definition.line,
          kind: definition.kind,
          provenance: {
            type: "generated-index",
            source: imported.file,
            generator: imported.generator,
          },
        }],
      }, repositoryId);
    }
    for (const reference of imported.references) {
      addEdge(edges, nodes, {
        from: reference.from,
        to: reference.to,
        kind: reference.kind,
        confidence: reference.confidence,
        provenance: {
          type: "generated-index",
          source: imported.file,
          path: reference.path,
          line: reference.line,
          generator: imported.generator,
        },
      }, repositoryId);
    }
  }

  const serializedNodes = [...nodes.values()].map(finalizeNode).sort((left, right) => compareText(left.key, right.key));
  const serializedEdges = [...edges.values()].sort(compareEdges);
  const sourceHash = sha256(stableJson({ nodes: serializedNodes, edges: serializedEdges }));
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    repositoryId,
    sourceHash,
    nodes: serializedNodes,
    edges: serializedEdges,
    stats: {
      nodeCount: serializedNodes.length,
      edgeCount: serializedEdges.length,
      unresolvedNodeCount: serializedNodes.filter((node) => node.unresolved).length,
      importedIndexCount: project.graphInputs?.length ?? 0,
    },
  };
}

export function renderRepositoryGraph(graph) {
  return stableStringify(graph);
}

function addEdge(edges, nodes, edge, localRepositoryId) {
  mergeNode(nodes, edge.from, {}, localRepositoryId);
  mergeNode(nodes, edge.to, {}, localRepositoryId);
  const normalized = {
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    confidence: Number(edge.confidence),
    provenance: {
      type: edge.provenance.type,
      source: toPosix(edge.provenance.source),
      path: edge.provenance.path ? toPosix(edge.provenance.path) : null,
      line: edge.provenance.line ?? null,
      generator: edge.provenance.generator ?? null,
    },
  };
  const identity = stableJson(normalized);
  if (edges.has(identity)) return;
  edges.set(identity, { id: sha256(identity), ...normalized });
}

function mergeNode(nodes, key, input, localRepositoryId) {
  const separator = key.indexOf("/");
  const repositoryId = separator >= 0 ? key.slice(0, separator) : localRepositoryId;
  const semanticId = separator >= 0 ? key.slice(separator + 1) : key;
  const current = nodes.get(key) ?? {
    key,
    repositoryId,
    semanticId,
    role: null,
    location: null,
    definitions: [],
    external: repositoryId !== localRepositoryId,
  };
  if (input.role) current.role = input.role;
  if (input.location) current.location = input.location;
  current.definitions.push(...(input.definitions ?? []));
  nodes.set(key, current);
}

function finalizeNode(node) {
  const definitions = [...new Map(node.definitions.map((definition) => [stableJson(definition), definition])).values()]
    .sort((left, right) => compareText(left.path, right.path) || (left.line ?? 0) - (right.line ?? 0) || compareText(left.symbol, right.symbol));
  return {
    ...node,
    unresolved: !node.role && definitions.length === 0,
    definitions,
  };
}

function qualifyId(id, repositoryId) {
  return String(id).includes("/") ? String(id) : `${repositoryId}/${id}`;
}

function groupCardsByPath(cards) {
  const output = new Map();
  for (const card of cards) {
    const file = toPosix(card.location.path);
    const records = output.get(file) ?? [];
    records.push(card);
    output.set(file, records);
  }
  return output;
}

function resolveLocalImport(sourcePath, specifier, cardsByPath) {
  if (!specifier.startsWith(".")) return [];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(sourcePath)), specifier));
  if (base.startsWith("../")) return [];
  const candidates = new Set([base]);
  const extension = path.posix.extname(base);
  if (!extension) {
    for (const item of IMPORT_EXTENSIONS) {
      candidates.add(`${base}${item}`);
      candidates.add(`${base}/index${item}`);
    }
  } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const stem = base.slice(0, -extension.length);
    for (const item of [".ts", ".tsx", ".mts", ".cts"]) candidates.add(`${stem}${item}`);
  }
  return [...candidates].flatMap((candidate) => cardsByPath.get(candidate) ?? []);
}

function compareEdges(left, right) {
  return compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.kind, right.kind) ||
    compareText(left.provenance.type, right.provenance.type) || compareText(left.provenance.source, right.provenance.source) ||
    (left.provenance.line ?? 0) - (right.provenance.line ?? 0);
}
