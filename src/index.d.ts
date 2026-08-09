export type LlmnavScope = "file" | "module" | "symbol";
export type LlmnavStability = "architecture" | "contract" | "implementation";
export type DiagnosticSeverity = "error" | "warning" | "info";

export interface LlmnavCard {
  scope: LlmnavScope;
  id: string;
  role: string;
  owns: string[];
  excludes: string[];
  search: string[];
  invariant: string[];
  effect: string[];
  risk: string[];
  rel: string[];
  stability: LlmnavStability | "";
  unknown?: Array<{ key: string; value: string; line: number }>;
}

export interface LlmnavEntry {
  key: string;
  value: string;
  line: number;
  order: number;
}

export interface LlmnavBlock {
  specVersion: string;
  filePath: string;
  scope: LlmnavScope;
  card: LlmnavCard;
  entries: LlmnavEntry[];
  syntaxErrors: Array<{ line: number; message: string }>;
  style: "block" | "html" | "line";
  prefix: string | null;
  indent: string;
  raw: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  newline: string;
}

export interface Declaration {
  kind: string;
  symbol: string;
  signature: string;
  line: number;
  offset: number;
}

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  file: string;
  line: number;
  column: number;
}

export interface IndexedLocation {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  kind: string | null;
  declarationLine: number | null;
  signature: string | null;
}

export interface IndexedCard extends Omit<LlmnavCard, "unknown"> {
  location: IndexedLocation;
  imports: string[];
  hashes: {
    semantic: string;
    structure: string;
    body: string;
  };
}

export interface LlmnavIndex {
  schemaVersion: number;
  specVersion: string;
  generatedBy: string;
  repositoryId: string;
  sourceHash: string;
  cards: IndexedCard[];
}

export interface SearchResult {
  id: string;
  score: number;
  reasons: string[];
  role: string;
  location: IndexedLocation;
  card: IndexedCard;
}

export interface RegistryRecord {
  id: string;
  state: "active" | "redirect" | "replaced" | "retired" | string;
  to?: string;
  by?: string[];
}

export interface Registry {
  records: RegistryRecord[];
  byId: Map<string, RegistryRecord>;
}

export interface LlmnavConfig {
  $schema?: string;
  version: 1;
  repositoryId: string;
  sourceRoots: string[];
  includeExtensions: string[];
  excludeDirectories: string[];
  excludeFiles: string[];
  coverageRules: Array<Record<string, unknown>>;
  lint: {
    maxRoleLength: number;
    maxSearchTerms: number;
    minSearchTerms: number;
    maxInvariants: number;
    maxEffects: number;
    maxRelations: number;
    maxBlockBytes: Record<LlmnavScope, number>;
    maxSemanticRatio: number;
    minimumSourceBytesForRatio: number;
    searchTermSaturation: number;
    minimumCardsForSaturation: number;
    genericSearchTerms: string[];
    vagueRoleWords: string[];
    strictRisks: string[];
    additionalEffects: string[];
    additionalRisks: string[];
    additionalRelations: string[];
    requireCanonicalOrder: boolean;
    requireCanonicalFormatting: boolean;
  };
  generation: {
    cacheDirectory: string;
    moduleDepth: number;
    repositoryCatalogStabilities: LlmnavStability[];
    moduleCatalogStabilities: LlmnavStability[];
  };
  evaluation: {
    queryFile: string;
    minimumRecallAt1: number;
    minimumRecallAt5: number;
  };
}

export interface ProjectRecord {
  root: string;
  absolutePath: string;
  relativePath: string;
  source: string;
  imports: string[];
  block: LlmnavBlock;
  card: LlmnavCard;
  declaration: Declaration | null;
}

export interface ScannedProject {
  root: string;
  config: LlmnavConfig;
  configPath: string;
  files: Array<{
    absolutePath: string;
    relativePath: string;
    source: string;
    blocks: LlmnavBlock[];
    imports: string[];
  }>;
  records: ProjectRecord[];
  registry: Registry;
  sourceBytes: number;
  semanticBytes: number;
}

export interface GenerationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  changedFiles: string[];
  project: ScannedProject;
  counts: { error: number; warning: number; info: number };
  artifacts?: Map<string, string>;
}

export interface EvaluationResult {
  ok: boolean;
  errors: string[];
  cases: Array<{
    query: string;
    expected: string[];
    actual: string[];
    rank: number | null;
    passAt1: boolean;
    passAt5: boolean;
  }>;
  metrics: {
    total: number;
    recallAt1: number;
    recallAt5: number;
    meanReciprocalRank: number;
  };
  thresholds?: LlmnavConfig["evaluation"];
}

export const AGENT_PROTOCOL: string;
export function installAgentInstructions(root: string, adapters?: string[]): Promise<string[]>;
export function loadConfig(root: string): Promise<{ config: LlmnavConfig; configPath: string }>;
export function validateConfig(config: LlmnavConfig, configPath?: string): void;
export function findAttachedDeclaration(source: string, block: LlmnavBlock, filePath: string): Declaration | null;
export function extractImports(source: string, filePath: string): string[];
export function doctorProject(root: string): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }> }>;
export function evaluateProject(root: string, options?: { top?: number; file?: string }): Promise<EvaluationResult>;
export function collectSourceFiles(root: string, config: LlmnavConfig, requestedPaths?: string[]): Promise<string[]>;
export function findProjectRoot(start?: string): Promise<string>;
export function formatProject(root: string, options?: { check?: boolean; paths?: string[] }): Promise<{ ok: boolean; changedFiles: string[]; errors: Array<{ file: string; line: number; message: string }> }>;
export function buildArtifacts(project: ScannedProject, order: string[]): Map<string, string>;
export function generateProject(root: string, options?: { check?: boolean }): Promise<GenerationResult>;
export function renderCompactCard(card: IndexedCard): string;
export function renderSemanticCard(card: IndexedCard): string;
export function initializeProject(root: string, options?: { force?: boolean; packageScripts?: boolean; agents?: string[] }): Promise<{ ok: boolean; changed: string[]; generated: GenerationResult }>;
export function canonicalizeSource(source: string, filePath?: string): { source: string; changed: boolean; blocks: LlmnavBlock[]; errors: Array<{ line: number; message: string }> };
export function cardToCanonicalObject(card: LlmnavCard): Record<string, string | string[]>;
export function formatLlmnavBlock(block: LlmnavBlock): string;
export function parseLlmnavBlocks(source: string, filePath?: string): LlmnavBlock[];
export function scanProject(root: string, options?: { paths?: string[] }): Promise<ScannedProject>;
export function ensureActiveIds(root: string, registry: Registry, ids: string[]): Promise<void>;
export function loadRegistry(root: string): Promise<Registry>;
export function resolveRegistryId(registry: Registry, id: string): { id: string; state: string; [key: string]: unknown };
export function buildContext(root: string, id: string, options?: { depth?: number; budget?: number }): Promise<{ id: string; depth: number; budget: number; included: string[]; text: string }>;
export function loadSearchData(root: string): Promise<{ index: LlmnavIndex; lexicon: { version?: number; aliases: Record<string, string> } }>;
export function queryIndex(index: LlmnavIndex, query: string, options?: { top?: number; lexicon?: { aliases: Record<string, string> } }): SearchResult[];
export function queryProject(root: string, query: string, options?: { top?: number }): Promise<SearchResult[]>;
export function showProjectCard(root: string, id: string): Promise<{ card: IndexedCard | null; resolvedFrom: unknown }>;
export function tokenize(value: string): string[];
export function countDiagnostics(diagnostics: Diagnostic[]): { error: number; warning: number; info: number };
export function diagnostic(severity: DiagnosticSeverity, code: string, message: string, file: string, line?: number, column?: number): Diagnostic;
export function validateProject(project: ScannedProject): Diagnostic[];

export * from "./spec.js";
