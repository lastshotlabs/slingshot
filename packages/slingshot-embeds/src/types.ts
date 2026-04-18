import { z } from 'zod';

/**
 * Structured metadata extracted from a URL via OG/meta tag parsing.
 *
 * All fields except `url` are optional because a target page may not
 * include any metadata tags.
 */
export interface UnfurlResult {
  /** The canonical URL that was unfurled. */
  url: string;
  /** Page title from `og:title`, `twitter:title`, or `<title>`. */
  title?: string;
  /** Page description from `og:description`, `twitter:description`, or `<meta name="description">`. */
  description?: string;
  /** Primary image URL from `og:image` or `twitter:image`. */
  image?: string;
  /** Site name from `og:site_name`. */
  siteName?: string;
  /** Favicon URL from `<link rel="icon">` or `<link rel="shortcut icon">`. */
  favicon?: string;
  /** Content type from `og:type` (e.g. `"article"`, `"website"`). */
  type?: string;
}

/**
 * Zod schema for {@link EmbedsPluginConfig}.
 *
 * Validates and provides defaults for all embeds plugin configuration options.
 */
export const embedsPluginConfigSchema = z.object({
  /** TTL for cached unfurl results in milliseconds. Defaults to 300 000 (5 minutes). */
  cacheTtlMs: z.number().int().positive().optional().default(300_000),
  /** Maximum number of cached entries before eviction. Defaults to 500. */
  cacheMaxEntries: z.number().int().positive().optional().default(500),
  /** Fetch timeout in milliseconds. Defaults to 5000. */
  timeoutMs: z.number().int().positive().optional().default(5000),
  /** Maximum response body size in bytes. Defaults to 1 048 576 (1 MB). */
  maxResponseBytes: z.number().int().positive().optional().default(1_048_576),
  /** If non-empty, only URLs from these domains are allowed. Empty means allow all. */
  allowedDomains: z.array(z.string()).optional().default([]),
  /** URLs from these domains are always blocked. */
  blockedDomains: z.array(z.string()).optional().default([]),
  /** Route mount path for the unfurl endpoint. Defaults to `"/embeds"`. */
  mountPath: z.string().startsWith('/').optional().default('/embeds'),
});

/**
 * Configuration for the slingshot-embeds plugin.
 *
 * All fields are optional and have sensible defaults. See {@link embedsPluginConfigSchema}
 * for validation rules and default values.
 */
export type EmbedsPluginConfig = z.infer<typeof embedsPluginConfigSchema>;
