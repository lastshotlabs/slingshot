/**
 * Regex that matches `@user-id` style mention tokens in free text.
 *
 * Uses a preceding-context guard so it does not match email addresses or
 * chained `@@bot` prefixes.
 */
const MENTION_PATTERN = /(?:^|[^\w@])@([A-Za-z0-9_-]{1,64})/g;

/**
 * Extract unique mention tokens from one or more text fields.
 *
 * @param fields - Text fields to scan.
 * @returns Unique mention tokens without the `@` prefix.
 */
export function extractMentionTokens(...fields: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const text of fields) {
    if (!text) continue;

    for (const match of text.matchAll(MENTION_PATTERN)) {
      const token = match[1];
      if (token && !seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  }

  return out;
}
