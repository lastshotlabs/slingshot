import type { UnfurlResult } from '../types';

/**
 * Extract the `<head>` section from an HTML document.
 *
 * Stops at `</head>` or `<body` to avoid scanning large document bodies.
 * Returns the full string if no `<head>` boundary is found.
 */
function extractHead(html: string): string {
  // Find the end of head — stop at </head> or <body
  const headEndPatterns = [/<\/head\b/i, /<body\b/i];
  let endIndex = html.length;
  for (const pattern of headEndPatterns) {
    const match = pattern.exec(html);
    if (match && match.index < endIndex) {
      endIndex = match.index;
    }
  }
  return html.slice(0, endIndex);
}

/**
 * Extract a meta tag's `content` attribute value.
 *
 * Handles both `<meta property="..." content="...">` and
 * `<meta name="..." content="...">` forms.
 * Supports single quotes, double quotes, self-closing tags, and mixed case.
 */
function extractMetaContent(
  head: string,
  attr: 'property' | 'name',
  value: string,
): string | undefined {
  // Match meta tags with the specified attribute and value, then capture content
  // Two patterns: attr before content, or content before attr
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Pattern 1: <meta property="og:title" content="value">
  const p1 = new RegExp(
    `<meta\\s+[^>]*?${attr}\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*?)["'][^>]*?\\/?>`,
    'i',
  );
  const m1 = p1.exec(head);
  if (m1) return decodeHtmlEntities(m1[1]);

  // Pattern 2: <meta content="value" property="og:title">
  const p2 = new RegExp(
    `<meta\\s+[^>]*?content\\s*=\\s*["']([^"']*?)["'][^>]*?${attr}\\s*=\\s*["']${escaped}["'][^>]*?\\/?>`,
    'i',
  );
  const m2 = p2.exec(head);
  if (m2) return decodeHtmlEntities(m2[1]);

  return undefined;
}

/**
 * Extract the `<title>` tag content.
 */
function extractTitle(head: string): string | undefined {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(head);
  return match ? decodeHtmlEntities(match[1].trim()) : undefined;
}

/**
 * Extract favicon URL from `<link rel="icon">` or `<link rel="shortcut icon">`.
 */
function extractFavicon(head: string): string | undefined {
  const pattern =
    /<link\s+[^>]*?rel\s*=\s*["'](?:shortcut\s+)?icon["'][^>]*?href\s*=\s*["']([^"']*?)["'][^>]*?\/?>/i;
  const match = pattern.exec(head);
  if (match) return match[1];

  // Also check href before rel
  const pattern2 =
    /<link\s+[^>]*?href\s*=\s*["']([^"']*?)["'][^>]*?rel\s*=\s*["'](?:shortcut\s+)?icon["'][^>]*?\/?>/i;
  const match2 = pattern2.exec(head);
  return match2 ? match2[1] : undefined;
}

/**
 * Decode common HTML entities in attribute values.
 */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Resolve a potentially relative URL against a base URL.
 *
 * Returns the original value if it is already absolute or if resolution fails.
 */
function resolveUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    // Invalid URL — return the original value as-is
    return value;
  }
}

/**
 * Parse Open Graph and fallback metadata from an HTML string.
 *
 * Extracts metadata from the `<head>` section only (stops at `</head>` or `<body`).
 * Checks OG tags first, falls back to Twitter card tags, then standard HTML tags.
 *
 * Relative URLs for `image` and `favicon` are resolved against `pageUrl` when provided.
 *
 * @param html - The raw HTML string to parse.
 * @param pageUrl - The URL of the page, used to resolve relative URLs.
 * @returns Partial unfurl result with whatever metadata was found.
 */
export function parseOgMetadata(html: string, pageUrl?: string): Partial<UnfurlResult> {
  const head = extractHead(html);
  const result: Partial<UnfurlResult> = {};

  // Title: og:title -> twitter:title -> <title>
  result.title =
    extractMetaContent(head, 'property', 'og:title') ??
    extractMetaContent(head, 'name', 'twitter:title') ??
    extractTitle(head);

  // Description: og:description -> twitter:description -> <meta name="description">
  result.description =
    extractMetaContent(head, 'property', 'og:description') ??
    extractMetaContent(head, 'name', 'twitter:description') ??
    extractMetaContent(head, 'name', 'description');

  // Image: og:image -> twitter:image
  const rawImage =
    extractMetaContent(head, 'property', 'og:image') ??
    extractMetaContent(head, 'name', 'twitter:image');
  result.image = pageUrl ? resolveUrl(rawImage, pageUrl) : rawImage;

  // Site name
  result.siteName = extractMetaContent(head, 'property', 'og:site_name');

  // Type
  result.type = extractMetaContent(head, 'property', 'og:type');

  // Favicon
  const rawFavicon = extractFavicon(head);
  result.favicon = pageUrl ? resolveUrl(rawFavicon, pageUrl) : rawFavicon;

  return Object.fromEntries(
    (Object.entries(result) as [string, string | undefined][]).filter(([, v]) => v !== undefined),
  ) as Partial<UnfurlResult>;
}
