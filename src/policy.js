/* llmnav/1 module
id=llmnav.support.policy
role=Keep named policies for search ranking, audit prioritization, declaration scanning, and context sizing.
owns=search ranking weights|search input limits|audit scoring|declaration scan limits|token estimates
excludes=query execution|configuration loading|agent transport
search=search ranking constants|query input limits|audit candidate limits|policy defaults|token estimation
rel=workflow>llmnav.search.query
rel=workflow>llmnav.agent.tool-schema
rel=workflow>llmnav.audit.coverage
stability=architecture
*/

export const SEARCH_RANK = Object.freeze({
  exactSemanticId: 1000,
  semanticIdPhrase: 100,
  semanticIdPhraseMinimumQueryLength: 3,
  alias: 500,
  exactPhrase: 40,
  exactPhraseMinimumQueryLength: 4,
  relationBonusFactor: 0.08,
  inboundRelationWeight: 0.6,
  seedCount: 3,
  reasonLimit: 6,
  scorePrecision: 3,
});

export const SEARCH_LIMITS = Object.freeze({
  top: Object.freeze({ default: 5, minimum: 1, maximum: 100 }),
  depth: Object.freeze({ default: 1, minimum: 0, maximum: 8 }),
  budget: Object.freeze({ default: 2500, minimum: 128, maximum: 100000 }),
  maxEdges: Object.freeze({ default: 24, minimum: 0, maximum: 1000 }),
});

export const AUDIT_LIMITS = Object.freeze({
  top: Object.freeze({ default: 10, minimum: 1, maximum: 50 }),
});

export const ID_MATCH_POLICY = Object.freeze({ gramLength: 3 });

export const AUDIT_SCORING = Object.freeze({
  entrypoint: 50,
  publicApi: 45,
  commandBoundary: 40,
  otherBoundary: 30,
  importer: 5,
  importerMaximum: 30,
  exportedDeclarations: 10,
  largeSource: 10,
  broadUtilityPenalty: 30,
  nonProductionPenalty: 40,
  reexportBarrelPenalty: 60,
  highPriorityMinimum: 60,
  mediumPriorityMinimum: 30,
});

export const AUDIT_REPRESENTATIVE = Object.freeze({
  entrypoint: 100_000,
  goPackageDocumentation: 50_000,
  exportedDeclaration: 1_000,
  sourceSizeMaximum: 999,
  sourceBytesPerPoint: 100,
});

export const DECLARATION_SCAN_POLICY = Object.freeze({
  attachmentWindowCharacters: 3000,
  signatureLines: 12,
  workUnitsPerCharacter: 2,
});

export const TOKEN_ESTIMATION = Object.freeze({
  asciiCharactersPerToken: 4,
  nonAsciiCodeUnitsPerToken: 1.8,
});
