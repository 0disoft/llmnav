// Shared selection rules keep producer and freshness checks aligned.
const PATTERNS = { typescript: /\.(?:[cm]?ts|tsx)$/u, javascript: /\.(?:[cm]?js|jsx)$/u, go: /\.go$/u, python: /\.py$/u, rust: /\.rs$/u };
export function analysisFilePattern(language) {
  if (!Object.hasOwn(PATTERNS, language)) throw new TypeError("analyze requires language typescript, javascript, go, python or rust.");
  return PATTERNS[language];
}
export const analysisIdPrefix = language => ({ typescript: "ts", javascript: "js", go: "go", python: "py", rust: "rs" })[language];
