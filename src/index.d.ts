export type LlmnavScope = "file" | "module" | "symbol";
export type LlmnavStability = "architecture" | "contract" | "implementation";
export type DiagnosticSeverity = "error" | "warning" | "info";
export type AuditPriority = "high" | "medium" | "low";

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
  language: "typescript" | "javascript" | "go" | "rust" | "python" | "generic";
  exported: boolean;
  visibility: "public" | "module" | "private";
  receiver: string | null;
  line: number;
  offset: number;
  endOffset: number;
  bodyHash: string;
}

export interface DetectedBoundary {
  kind: "command" | "event" | "migration" | "route" | "schema";
  confidence: "high" | "medium";
  evidence: string[];
}

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  file: string;
  line: number;
  column: number;
}

export interface AuditCandidate {
  path: string;
  priority: AuditPriority;
  score: number;
  reasons: string[];
  signals: {
    packageEntrypoint: boolean;
    publicApi: boolean;
    exportedDeclarations: number;
    importedBy: number;
    boundaries: DetectedBoundary["kind"][];
    largeSource: boolean;
    broadUtility: boolean;
    nonProduction: boolean;
    reexportBarrel: boolean;
  };
  suggestedCoverageRule: null | {
    name: string;
    match: [string];
    scope: "module";
    requiredFields: ["owns", "search"];
  };
}

export interface AuditResult {
  schemaVersion: 1;
  repositoryId: string;
  summary: {
    analyzedFiles: number;
    cardedFiles: number;
    filesWithoutModuleCards: number;
    candidates: number;
    high: number;
    medium: number;
    low: number;
    coverageSuggestions: number;
  };
  candidates: AuditCandidate[];
}

export interface IndexedLocation {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  kind: string | null;
  declarationLine: number | null;
  signature: string | null;
  language: Declaration["language"] | null;
  exported: boolean | null;
  visibility: Declaration["visibility"] | null;
  receiver: string | null;
}

export interface IndexedCard extends Omit<LlmnavCard, "unknown"> {
  location: IndexedLocation;
  imports: string[];
  boundaries: DetectedBoundary[];
  hashes: {
    semantic: string;
    structure: string;
    body: string;
  };
}

export interface LlmnavIndex {
  schemaVersion: 1;
  specVersion: string;
  generatedBy: string;
  repositoryId: string;
  contractFingerprints?: ContractFingerprints;
  sourceHash: string;
  cards: IndexedCard[];
}

export interface ContractFingerprint {
  sha256: string;
  count?: number;
}

export interface ContractFingerprints {
  schemaVersion: 1;
  exportedApi: ContractFingerprint;
  configuration: ContractFingerprint;
}

export interface ContractFingerprintChange {
  kind: "exportedApi" | "configuration";
  previous: string | null;
  current: string | null;
}

export interface SearchDocument {
  hash: string;
  phrases: string[];
  terms: Array<[token: string, sparseFieldCounts: number[]]>;
  tokens: string[];
}

export type CompactSearchDocument = [hash: string, phrases: string[]];
export type CompactSearchPosting = [cardIndex: number, sparseFieldCounts: number[]];

export interface LlmnavSearchIndex {
  schemaVersion: 2;
  encoding: "compact-v1";
  tokenizerVersion: number;
  repositoryId: string;
  cardSetHash: string;
  documentCount: number;
  fieldOrder: string[];
  cardIds: string[];
  tokens: string[];
  documents: CompactSearchDocument[];
  postings: CompactSearchPosting[][];
}

export interface SearchIndexStats {
  previousUsable: boolean;
  totalCards: number;
  reusedCards: number;
  indexedCards: number;
  removedCards: number;
  changedIds: string[];
  removedIds: string[];
  tokenCount: number;
}

export interface SearchMetrics {
  queryTokens?: number;
  documentTokenizations?: number;
  postingVisits?: number;
  phraseDocumentsScanned?: number;
  idDocumentsScanned?: number;
  graphEdgesVisited?: number;
}

export interface SearchResult {
  id: string;
  score: number;
  reasons: string[];
  role: string;
  location: IndexedLocation;
  card: IndexedCard;
}

export interface ProjectSession {
  root: string;
  query(query: string, options?: { top?: number }): SearchResult[];
  show(id: string): { card: IndexedCard | null; node: GraphNode | null; resolvedFrom: unknown };
  context(id: string, options?: { depth?: number; budget?: number; maxEdges?: number }): { id: string; depth: number; budget: number; maxEdges: number; included: string[]; includedEdges: string[]; text: string };
  refresh(): Promise<ProjectSession>;
}

export interface RegistryRecord {
  id: string;
  state: "active" | "redirect" | "replaced" | "retired" | string;
  to?: string;
  by?: string[];
}

export interface Registry {
  registryPath: string;
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
  graph: {
    indexFiles: string[];
  };
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
    searchShardSize: number;
    repositoryCatalogStabilities: LlmnavStability[];
    moduleCatalogStabilities: LlmnavStability[];
  };
  evaluation: {
    queryFile: string;
    minimumRecallAt1: number;
    minimumRecallAt5: number;
  };
}

export interface AgentToolDefinition {
  schemaVersion: 1;
  name: "llmnav_query" | "llmnav_show" | "llmnav_context" | "llmnav_check";
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface AgentOperationResult<T = unknown> {
  schemaVersion: 1;
  operation: "query" | "show" | "context" | "check" | "unknown";
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

export interface PromptPrefixPartition {
  id: string;
  cacheScope: "package" | "repository" | "module";
  contentType: string;
  contentHash: string;
  estimatedTokens: number;
  cacheBoundaryAfter: true;
  content: string;
}

export interface PromptPrefixBundle {
  schemaVersion: 1;
  repositoryId: string;
  bundleHash: string;
  assembly: {
    basePartitionIds: string[];
    modulePartitionIds: string[];
    volatileContextAfter: true;
  };
  partitions: PromptPrefixPartition[];
}

export interface EditorDiagnosticDocument {
  path: string;
  diagnostics: Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity: 1 | 2 | 3;
    level: DiagnosticSeverity;
    code: string;
    source: "llmnav";
    message: string;
  }>;
}

export interface EditorDiagnosticReport {
  schemaVersion: 1;
  source: "llmnav";
  coordinateBase: 0;
  counts: { error: number; warning: number; info: number };
  documents: EditorDiagnosticDocument[];
}

export interface ProjectFileRecord {
  absolutePath: string;
  relativePath: string;
  source: string | null;
  contentHash: string;
  bodyHash: string;
  sourceBytes: number;
  semanticBytes: number;
  blocks: LlmnavBlock[];
  imports: string[];
}

export interface ProjectRecord {
  root: string;
  absolutePath: string;
  relativePath: string;
  source: string | null;
  bodyHash: string;
  imports: string[];
  block: LlmnavBlock;
  card: LlmnavCard;
  declaration: Declaration | null;
}

export interface ScannedProject {
  root: string;
  config: LlmnavConfig;
  configPath: string;
  files: string[];
  fileRecords: ProjectFileRecord[];
  records: ProjectRecord[];
  registry: Registry;
  sourceBytes: number;
  semanticBytes: number;
  graphInputs?: GraphInputIndex[];
}

export interface GraphDefinition {
  id: string;
  symbol: string;
  path: string;
  line: number | null;
  kind: string | null;
}

export interface GraphReference {
  from: string;
  to: string;
  kind: string;
  path: string | null;
  line: number | null;
  confidence: number;
}

export interface GraphInputIndex {
  file: string;
  contentHash: string | null;
  schemaVersion: 1;
  repositoryId: string;
  generator: string | null;
  definitions: GraphDefinition[];
  references: GraphReference[];
}

export interface GraphProvenance {
  type: "source-card" | "local-import" | "generated-index" | string;
  source: string;
  path: string | null;
  line: number | null;
  generator: string | null;
}

export interface GraphNode {
  key: string;
  repositoryId: string;
  semanticId: string;
  role: string | null;
  location: IndexedLocation | null;
  external: boolean;
  unresolved: boolean;
  definitions: Array<{
    symbol: string;
    path: string;
    line: number | null;
    kind: string | null;
    provenance: Omit<GraphProvenance, "path" | "line">;
  }>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  confidence: number;
  provenance: GraphProvenance;
}

export interface RepositoryGraph {
  schemaVersion: 1;
  repositoryId: string;
  sourceHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { nodeCount: number; edgeCount: number; unresolvedNodeCount: number; importedIndexCount: number };
}

export interface GraphStatePartition {
  key: string;
  inputHash: string;
  outputHash: string;
  nodes: Array<Omit<GraphNode, "unresolved">>;
  edges: GraphEdge[];
}

export interface RepositoryGraphState {
  schemaVersion: 1;
  repositoryId: string;
  resolutionHash: string;
  partitions: GraphStatePartition[];
}

export interface IncrementalGraphStats {
  totalPartitions: number;
  reusedPartitions: number;
  rebuiltPartitions: number;
  removedPartitions: number;
}

export interface SerializedFileStateRecord {
  path: string;
  contentHash: string;
  sourceBytes: number;
  semanticBytes: number;
  imports: string[];
  blocks: LlmnavBlock[];
  declarations: Array<Declaration | null>;
}

export interface LlmnavFileState {
  schemaVersion: number;
  indexerVersion: number;
  files: SerializedFileStateRecord[];
}

export interface IncrementalFileStats {
  totalFiles: number;
  parsedFiles: number;
  reusedFiles: number;
  reusedFilesByStat: number;
  reusedFilesByHash: number;
  deletedFiles: number;
  bytesRead: number;
  cardsParsed: number;
  cardsReused: number;
}

export interface ChangedCardRecord {
  id: string;
  change: "added" | "modified" | "removed";
  dimensions: Array<"semantic" | "structure" | "body">;
  previous: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
}

export interface AffectedCatalogRecord {
  file: string;
  kind: "repository" | "module" | "agent-context" | "prompt-prefix";
  id: string;
}

export interface AffectedBoundaryRecord {
  id: string;
  change: ChangedCardRecord["change"];
  dimensions: ChangedCardRecord["dimensions"];
  modules: string[];
  boundaries: DetectedBoundary[];
  relatedIds: string[];
  dependentIds: string[];
}

export interface TransactionResult {
  committed: boolean;
  skipped: boolean;
  recovered: boolean;
  recoveryAction: string;
  transactionId?: string;
  replacedExisting?: boolean;
}

export interface GenerationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  changedFiles: string[];
  changedCards: ChangedCardRecord[];
  affectedBoundaries: AffectedBoundaryRecord[];
  affectedCatalogs: AffectedCatalogRecord[];
  project: ScannedProject;
  counts: { error: number; warning: number; info: number };
  artifacts?: Map<string, string>;
  index?: LlmnavIndex;
  searchIndex?: LlmnavSearchIndex;
  graph?: RepositoryGraph;
  incremental: {
    enabled: boolean;
    files: IncrementalFileStats;
    cards: SearchIndexStats | null;
    graph: IncrementalGraphStats | null;
    statHintsPersisted?: boolean;
    statHintsError?: string | null;
  };
  transaction: TransactionResult;
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
export const AUDIT_PRIORITIES: readonly AuditPriority[];
export const AUDIT_SCHEMA_VERSION: 1;
export const AGENT_OPERATION_SCHEMA_VERSION: 1;
export const AGENT_TOOL_SCHEMA_VERSION: 1;
export const BOUNDARY_KINDS: readonly DetectedBoundary["kind"][];
export const GRAPH_INPUT_SCHEMA_VERSION: 1;
export const EDITOR_DIAGNOSTIC_SCHEMA_VERSION: 1;
export const EDITOR_INTEGRATION_SCHEMA_VERSION: 1;
export const GRAPH_SCHEMA_VERSION: 1;
export const GRAPH_STATE_SCHEMA_VERSION: 1;
export const PROMPT_BUNDLE_SCHEMA_VERSION: 1;
export const SARIF_SCHEMA: string;
export const SARIF_VERSION: "2.1.0";
export const SEARCH_SHARD_ENCODING: "card-range-v1";
export const SEARCH_SHARD_SCHEMA_VERSION: 1;
export const CONTRACT_FINGERPRINT_SCHEMA_VERSION: 1;
export const FILE_STATE_SCHEMA_VERSION: number;
export const SOURCE_INDEXER_VERSION: number;
export const SEARCH_INDEX_ENCODING: "compact-v1";
export const SEARCH_INDEX_SCHEMA_VERSION: 2;
export const SEARCH_FIELD_ORDER: readonly string[];
export const SEARCH_FIELD_WEIGHTS: Readonly<Record<string, number>>;
export const TOKENIZER_VERSION: number;
export const TRANSACTION_SCHEMA_VERSION: number;
export const TRANSACTION_ABORT_EXIT_CODE: number;

export function installAgentInstructions(root: string, adapters?: string[]): Promise<string[]>;
export function diagnosticsToEditor(diagnostics: Diagnostic[]): EditorDiagnosticReport;
export function renderEditorDiagnostics(diagnostics: Diagnostic[]): string;
export function getEditorIntegration(name: "vscode"): { schemaVersion: 1; editor: "vscode"; target: ".vscode/tasks.json"; config: Record<string, unknown> };
export function getAgentToolDefinitions(): AgentToolDefinition[];
export function executeAgentOperation(root: string, name: string, input?: Record<string, unknown>, options?: { session?: ProjectSession }): Promise<AgentOperationResult>;
export function buildPromptPrefixBundle(input: { repositoryId: string; toolDefinitions: AgentToolDefinition[]; agentProtocol: string; repositoryCore: string; modules?: Array<{ id: string; content: string }> }): PromptPrefixBundle;
export function isCompatiblePromptPrefixBundle(bundle: unknown, repositoryId?: string): bundle is PromptPrefixBundle;
export function loadPromptPrefixBundle(root: string): Promise<PromptPrefixBundle>;
export function renderPromptPrefixBundle(bundle: PromptPrefixBundle): string;
export function detectBoundaries(record: ProjectRecord): DetectedBoundary[];
export function normalizeGraphInput(value: unknown, file?: string, contentHash?: string | null): GraphInputIndex;
export function loadGraphInputs(root: string, config: LlmnavConfig): Promise<{ indexes: GraphInputIndex[]; diagnostics: Diagnostic[] }>;
export function buildRepositoryGraph(project: ScannedProject, index: LlmnavIndex): RepositoryGraph;
export function buildRepositoryGraphIncremental(project: ScannedProject, index: LlmnavIndex, previousState?: RepositoryGraphState | null): {
  graph: RepositoryGraph;
  state: RepositoryGraphState;
  stats: IncrementalGraphStats;
};
export function compatibleGraphState(state: unknown, repositoryId?: string): state is RepositoryGraphState;
export function isCompatibleRepositoryGraph(graph: unknown, repositoryId?: string): graph is RepositoryGraph;
export function renderRepositoryGraph(graph: RepositoryGraph): string;
export function renderGraphState(state: RepositoryGraphState): string;
export function renderGraphNode(node: GraphNode): string;
export function resolveGraphNode(graph: RepositoryGraph | null | undefined, id: string, localRepositoryId?: string): {
  state: "resolved" | "ambiguous" | "missing";
  id: string;
  candidates: string[];
  node: GraphNode | null;
};
export function diagnosticsToSarif(diagnostics: Diagnostic[]): Record<string, unknown>;
export function buildSearchShards(index: LlmnavIndex, searchIndex: LlmnavSearchIndex, shardSize: number): {
  manifest: null | {
    schemaVersion: 1;
    encoding: "card-range-v1";
    repositoryId: string;
    sourceCardSetHash: string;
    shardSize: number;
    shardCount: number;
    shards: Array<{ file: string; firstId: string; lastId: string; cardCount: number; cardSetHash: string; sha256: string }>;
  };
  shards: Map<string, string>;
};
export function buildContractFingerprints(project: ScannedProject, cards: IndexedCard[]): ContractFingerprints;
export function compareContractFingerprints(previous: ContractFingerprints | null | undefined, current: ContractFingerprints | null | undefined): ContractFingerprintChange[];
export function compareCardIndexes(previousIndex: LlmnavIndex | null, currentIndex: LlmnavIndex): ChangedCardRecord[];
export function describeAffectedBoundaries(changedCards: ChangedCardRecord[], config: LlmnavConfig, previousIndex: LlmnavIndex | null, currentIndex: LlmnavIndex): AffectedBoundaryRecord[];
export function describeAffectedCatalogs(changedFiles: string[], cacheDirectory: string, config: LlmnavConfig, previousIndex: LlmnavIndex | null, currentIndex: LlmnavIndex): AffectedCatalogRecord[];
export function loadConfig(root: string): Promise<{ config: LlmnavConfig; configPath: string }>;
export function validateConfig(config: LlmnavConfig, configPath?: string): void;
export function auditProject(root: string): Promise<AuditResult>;
export function auditHasFindings(result: AuditResult, minimumPriority?: AuditPriority | "none"): boolean;
export function findAttachedDeclaration(source: string, block: LlmnavBlock, filePath: string): Declaration | null;
export function extractImports(source: string, filePath: string): string[];
export function doctorProject(root: string): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }> }>;
export function evaluateProject(root: string, options?: { top?: number; file?: string }): Promise<EvaluationResult>;
export function collectSourceFiles(root: string, config: LlmnavConfig, requestedPaths?: string[]): Promise<string[]>;
export function findProjectRoot(start?: string): Promise<string>;
export function formatProject(root: string, options?: { check?: boolean; paths?: string[] }): Promise<{ ok: boolean; changedFiles: string[]; errors: Array<{ file: string; line: number; message: string }> }>;
export function buildArtifacts(project: ScannedProject, order: string[], options?: { previousSearchIndex?: LlmnavSearchIndex | null; previousGraphState?: RepositoryGraphState | null; fileState?: LlmnavFileState }): Map<string, string>;
export function buildArtifactSet(project: ScannedProject, order: string[], options?: { previousSearchIndex?: LlmnavSearchIndex | null; previousGraphState?: RepositoryGraphState | null; fileState?: LlmnavFileState }): { artifacts: Map<string, string>; index: LlmnavIndex; searchIndex: LlmnavSearchIndex; searchStats: SearchIndexStats; fileState: LlmnavFileState; graph: RepositoryGraph; graphState: RepositoryGraphState; graphStats: IncrementalGraphStats; promptBundle: PromptPrefixBundle; moduleManifest: Array<{ id: string; file: string; cards: number }> };
export function generateProject(root: string, options?: { check?: boolean; incremental?: boolean; useStatHints?: boolean; paths?: string[]; failpoint?: string; renameOptions?: Record<string, unknown>; lockOptions?: Record<string, unknown>; onTransactionPhase?: (phase: string) => void | Promise<void> }): Promise<GenerationResult>;
export function renderCompactCard(card: IndexedCard): string;
export function renderSemanticCard(card: IndexedCard): string;
export function scanProjectIncremental(root: string, options?: { paths?: string[]; useStatHints?: boolean; previousState?: LlmnavFileState }): Promise<{ project: ScannedProject; fileState: LlmnavFileState; stats: IncrementalFileStats; statHints: unknown; hintsPath: string }>;
export function buildFileStateFromProject(project: ScannedProject): LlmnavFileState;
export function renderFileState(fileState: LlmnavFileState): string;
export function usableFileState(value: unknown): value is LlmnavFileState;
export function initializeProject(root: string, options?: { force?: boolean; packageScripts?: boolean; agents?: string[] }): Promise<{ ok: boolean; changed: string[]; generated: GenerationResult }>;
export function buildInvertedIndex(index: LlmnavIndex, previous?: LlmnavSearchIndex | null): { searchIndex: LlmnavSearchIndex; stats: SearchIndexStats };
export function buildSearchDocument(card: IndexedCard, hash?: string): SearchDocument;
export function isCompatibleSearchIndex(searchIndex: unknown, repositoryId?: string): searchIndex is LlmnavSearchIndex;
export function renderSearchIndex(searchIndex: LlmnavSearchIndex): string;
export function searchCardSetHash(cards: IndexedCard[]): string;
export function searchDocumentHash(card: IndexedCard): string;
export function verifySearchIndex(index: LlmnavIndex, searchIndex: LlmnavSearchIndex): boolean;
export function canonicalizeSource(source: string, filePath?: string): { source: string; changed: boolean; blocks: LlmnavBlock[]; errors: Array<{ line: number; message: string }> };
export function cardToCanonicalObject(card: LlmnavCard): Record<string, string | string[]>;
export function formatLlmnavBlock(block: LlmnavBlock): string;
export function parseLlmnavBlocks(source: string, filePath?: string): LlmnavBlock[];
export function scanProject(root: string, options?: { paths?: string[] }): Promise<ScannedProject>;
export function ensureActiveIds(root: string, registry: Registry, ids: string[]): Promise<{ records: RegistryRecord[]; changed: boolean }>;
export function mergeActiveIds(registry: Registry, ids: string[]): { records: RegistryRecord[]; changed: boolean };
export function renderRegistryRecords(records: RegistryRecord[]): string;
export function loadRegistry(root: string): Promise<Registry>;
export function resolveRegistryId(registry: Registry, id: string): { id: string; state: string; [key: string]: unknown };
export function buildContext(root: string, id: string, options?: { depth?: number; budget?: number; maxEdges?: number }): Promise<{ id: string; depth: number; budget: number; maxEdges: number; included: string[]; includedEdges: string[]; text: string }>;
export function createProjectSession(root: string): Promise<ProjectSession>;
export function loadSearchData(root: string): Promise<{ index: LlmnavIndex; searchIndex: LlmnavSearchIndex; lexicon: { version?: number; aliases: Record<string, string | string[]> }; graph: RepositoryGraph | null }>;
export function queryIndex(index: LlmnavIndex, query: string, options?: { top?: number; lexicon?: { aliases: Record<string, string | string[]> }; invertedIndex?: LlmnavSearchIndex; metrics?: SearchMetrics; graph?: RepositoryGraph | null }): SearchResult[];
export function queryPreparedIndex(index: LlmnavIndex, searchIndex: LlmnavSearchIndex, query: string, options?: { top?: number; lexicon?: { aliases: Record<string, string | string[]> }; metrics?: SearchMetrics; graph?: RepositoryGraph | null }): SearchResult[];
export function queryIndexLegacy(index: LlmnavIndex, query: string, options?: { top?: number; lexicon?: { aliases: Record<string, string | string[]> } }): SearchResult[];
export function queryProject(root: string, query: string, options?: { top?: number }): Promise<SearchResult[]>;
export function showProjectCard(root: string, id: string): Promise<{ card: IndexedCard | null; node: GraphNode | null; resolvedFrom: unknown }>;
export function tokenize(value: string): string[];
export function normalizeSearchText(value: string): string;
export function commitGeneratedCache(root: string, cacheDirectory: string, artifacts: Map<string, string>, options?: Record<string, unknown>): Promise<TransactionResult>;
export function recoverGenerationTransaction(root: string, options?: { cacheDirectory?: string; renameOptions?: Record<string, unknown>; lockOptions?: Record<string, unknown> }): Promise<{ recovered: boolean; action: string }>;
export function acquireGenerationLock(root: string, options?: Record<string, unknown>): Promise<{ root: string; lockPath: string; ownerId: string }>;
export function releaseGenerationLock(lock: { root: string; lockPath: string; ownerId: string }): Promise<void>;
export function withGenerationLock<T>(root: string, callback: (lock: { root: string; lockPath: string; ownerId: string }) => T | Promise<T>, options?: Record<string, unknown>): Promise<T>;
export function renameWithRetry(source: string, destination: string, options?: Record<string, unknown>): Promise<void>;
export function removeWithRetry(target: string, options?: Record<string, unknown>): Promise<void>;
export function countDiagnostics(diagnostics: Diagnostic[]): { error: number; warning: number; info: number };
export function diagnostic(severity: DiagnosticSeverity, code: string, message: string, file: string, line?: number, column?: number): Diagnostic;
export function validateProject(project: ScannedProject): Diagnostic[];

export * from "./spec.js";
