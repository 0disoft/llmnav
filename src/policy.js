/* llmnav/1 module
id=llmnav.support.policy
role=Keep one source of truth for search ranking weights and bounded input defaults.
owns=search ranking weights|search input limits|audit input limits
excludes=query execution|configuration loading|agent transport
search=search ranking constants|query input limits|audit candidate limits|policy defaults
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
