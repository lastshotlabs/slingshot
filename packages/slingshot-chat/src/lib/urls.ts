/**
 * Extract URLs from a message body.
 *
 * Uses a simple regex that matches `http(s)://...` patterns. This is a
 * fallback — when `slingshot-embeds` is registered, it may provide its own
 * parser. The fallback is sufficient for trigger detection.
 *
 * @param text - Message body text.
 * @param limit - Maximum number of URLs to return. Default: 5.
 * @returns Array of URL strings.
 */
export function extractUrls(text: string | undefined | null, limit = 5): string[] {
  if (!text) return [];

  const URL_PATTERN = /https?:\/\/[^\s<>)"']+/gi;
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0];
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
      if (urls.length >= limit) break;
    }
  }

  return urls;
}
