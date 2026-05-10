/**
 * Extract URLs from a thread or reply body.
 *
 * Mirrors the simple regex used by `slingshot-chat/lib/urls`. Sufficient for
 * trigger detection — `slingshot-embeds` handles validation, SSRF, and
 * unfurl on the URLs we hand it.
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
