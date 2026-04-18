/**
 * Word validation recipe.
 *
 * Simple word validation and fuzzy matching utilities for trivia,
 * word games, and text-based answer checking.
 *
 * See spec §23.2 for the API contract.
 */

/** Fuzzy match result. */
export interface FuzzyMatchResult {
  readonly match: boolean;
  readonly confidence: number;
}

/**
 * Check if a word is valid.
 *
 * Uses a basic validation approach: non-empty, alphabetic characters only,
 * reasonable length. For full dictionary validation, supply a custom word
 * list via `isValidWith()`.
 */
function isValid(word: string): boolean {
  if (!word || word.length === 0) return false;
  if (word.length > 50) return false;
  return /^[a-zA-Z]+$/.test(word.trim());
}

/**
 * Check if a word is valid against a custom word list.
 *
 * @param word - The word to validate.
 * @param wordSet - A Set of valid words (lowercase).
 */
function isValidWith(word: string, wordSet: ReadonlySet<string>): boolean {
  return wordSet.has(word.toLowerCase().trim());
}

/**
 * Fuzzy match two strings.
 *
 * Useful for scoring partial or slightly misspelled answers.
 * Uses Levenshtein distance normalized by the longer string's length.
 *
 * @param input - The user's answer.
 * @param target - The correct answer.
 * @param threshold - Minimum confidence to count as a match. Default: 0.7.
 */
function fuzzyMatch(input: string, target: string, threshold?: number): FuzzyMatchResult {
  const minConfidence = threshold ?? 0.7;
  const a = normalize(input);
  const b = normalize(target);

  if (a === b) return { match: true, confidence: 1.0 };
  if (a.length === 0 || b.length === 0) return { match: false, confidence: 0 };

  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const confidence = 1 - distance / maxLen;

  return {
    match: confidence >= minConfidence,
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * Check if an answer matches any of the accepted answers.
 *
 * @param input - The user's answer.
 * @param accepted - Array of accepted answers.
 * @param threshold - Fuzzy match threshold. Default: 0.7.
 */
function matchesAny(input: string, accepted: string[], threshold?: number): FuzzyMatchResult {
  let bestMatch: FuzzyMatchResult = { match: false, confidence: 0 };

  for (const target of accepted) {
    const result = fuzzyMatch(input, target, threshold);
    if (result.confidence > bestMatch.confidence) {
      bestMatch = result;
    }
    if (result.match && result.confidence === 1.0) break;
  }

  return bestMatch;
}

/** Normalize a string for comparison. */
function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Compute Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use two rows for space efficiency
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

export const wordValidator = {
  isValid,
  isValidWith,
  fuzzyMatch,
  matchesAny,
};
