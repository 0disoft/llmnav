/* llmnav/1 module
id=llmnav.search.tokenize
role=Normalize task text and emit deterministic word and CJK n-gram tokens for semantic retrieval.
owns=query normalization|CJK n-grams|tokenizer version
excludes=card ranking|inverted-index persistence
search=search tokenizer|CJK ngram|query normalization
rel=workflow>llmnav.search.query
stability=architecture
*/

export const TOKENIZER_VERSION = 1;

export function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

export function tokenize(value) {
  const normalized = normalizeSearchText(value);
  const base = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = [...base];
  for (const token of base) {
    if (containsCjk(token) && [...token].length >= 3) {
      const characters = [...token];
      for (let index = 0; index <= characters.length - 2; index += 1) {
        tokens.push(characters.slice(index, index + 2).join(""));
      }
      for (let index = 0; index <= characters.length - 3; index += 1) {
        tokens.push(characters.slice(index, index + 3).join(""));
      }
    }
  }
  return tokens;
}

function containsCjk(value) {
  return /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}
