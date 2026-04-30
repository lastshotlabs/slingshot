// packages/slingshot-ssr/src/metadata/index.ts
// Metadata file route handlers: sitemap.xml, robots.txt, manifest.webmanifest.
//
// The SSR plugin mounts these as explicit Hono routes BEFORE SSR middleware,
// so they take priority. Each handler checks for a convention file adjacent to
// serverRoutesDir (in the server/ directory) and calls its default export.
//
// Convention files:
//   server/sitemap.ts   → GET /sitemap.xml
//   server/robots.ts    → GET /robots.txt
//   server/manifest.ts  → GET /manifest.webmanifest, /manifest.json
//
// If the convention file does not exist, the route falls through to SSR/SPA.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createConsoleLogger } from '@lastshotlabs/slingshot-core';

const logger = createConsoleLogger({ base: { component: 'slingshot-ssr' } });

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single entry in a sitemap response.
 *
 * Serialised to a `<url>` element in the sitemap XML output.
 * All fields except `url` are optional and omitted from the XML when undefined.
 *
 * @example
 * ```ts
 * // server/sitemap.ts
 * import type { SitemapEntry } from '@lastshotlabs/slingshot-ssr'
 *
 * export default async function sitemap(): Promise<SitemapEntry[]> {
 *   const posts = await db.posts.findAll()
 *   return posts.map(p => ({
 *     url: `https://example.com/posts/${p.slug}`,
 *     lastModified: p.updatedAt,
 *     changeFrequency: 'weekly',
 *     priority: 0.8,
 *   }))
 * }
 * ```
 */
export interface SitemapEntry {
  /** Absolute URL. */
  url: string;
  /**
   * Last modification date. ISO-8601 string or `Date` instance.
   * Serialised to W3C datetime format (`YYYY-MM-DD`) in the XML output.
   */
  lastModified?: string | Date;
  /** How frequently the page is likely to change. */
  changeFrequency?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  /**
   * Priority of this URL relative to other URLs on the site. Range: `0.0`–`1.0`.
   * Omitted from XML when undefined.
   */
  priority?: number;
  /**
   * Hreflang alternates for internationalised routes.
   * Key is a BCP-47 locale tag (e.g. `'en'`, `'fr'`), value is the absolute URL
   * for that locale.
   */
  alternates?: { languages?: Record<string, string> };
}

/**
 * Configuration for robots.txt generation.
 *
 * @example
 * ```ts
 * // server/robots.ts
 * import type { RobotsConfig } from '@lastshotlabs/slingshot-ssr'
 *
 * export default function robots(): RobotsConfig {
 *   return {
 *     rules: [
 *       { userAgent: '*', allow: '/', disallow: '/api/' },
 *     ],
 *     sitemap: 'https://example.com/sitemap.xml',
 *   }
 * }
 * ```
 */
export interface RobotsConfig {
  /** Crawl rules per user-agent. */
  rules?: ReadonlyArray<{
    /**
     * User-agent selector. Defaults to `'*'` when omitted.
     * Pass an array to apply the same rules to multiple agents.
     */
    userAgent?: string | readonly string[];
    /** URL path(s) the agent is allowed to crawl. */
    allow?: string | readonly string[];
    /** URL path(s) the agent is not allowed to crawl. */
    disallow?: string | readonly string[];
    /** Crawl delay in seconds. */
    crawlDelay?: number;
  }>;
  /**
   * Absolute URL(s) to the sitemap. Added as `Sitemap:` directives at the
   * end of the robots.txt output.
   */
  sitemap?: string | readonly string[];
  /**
   * Canonical hostname for the site. Added as a `Host:` directive when provided.
   */
  host?: string;
}

// ─── Structural Hono app type ─────────────────────────────────────────────────

/**
 * Minimal structural interface for a Hono application.
 *
 * Typed structurally so that `slingshot-ssr` does not import Hono types directly
 * in this module. The real Hono `app` satisfies this interface at runtime.
 *
 * @internal
 */
interface HonoAppShape {
  get(path: string, handler: (c: HonoContextShape) => unknown): void;
}

/**
 * Minimal structural interface for a Hono request context.
 * @internal
 */
interface HonoContextShape {
  body(data: string, status: number, headers: Record<string, string>): Response;
}

function asArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return [...value];
  return [value as T];
}

// ─── Serialisation helpers ────────────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in XML text content.
 * @internal
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Serialise a `Date` or ISO-8601 string to a W3C datetime date string (`YYYY-MM-DD`).
 * Returns the original string when it cannot be parsed.
 * @internal
 */
function toW3cDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

/**
 * Convert an array of `SitemapEntry` objects to a sitemap XML string.
 *
 * Produces a valid `<urlset>` document conforming to the sitemaps.org 0.9 schema.
 * All URL values are XML-escaped. Undefined fields are omitted from the output.
 *
 * @param entries - The sitemap entries to serialise.
 * @returns A complete sitemap XML string.
 * @internal
 */
function serializeSitemap(entries: SitemapEntry[]): string {
  const urlElements = entries.map(entry => {
    const parts: string[] = [`  <url>`, `    <loc>${escapeXml(entry.url)}</loc>`];

    if (entry.lastModified !== undefined) {
      parts.push(`    <lastmod>${escapeXml(toW3cDate(entry.lastModified))}</lastmod>`);
    }
    if (entry.changeFrequency !== undefined) {
      parts.push(`    <changefreq>${escapeXml(entry.changeFrequency)}</changefreq>`);
    }
    if (entry.priority !== undefined) {
      parts.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
    }

    // hreflang alternates
    if (entry.alternates?.languages) {
      for (const [lang, href] of Object.entries(entry.alternates.languages)) {
        parts.push(
          `    <xhtml:link rel="alternate" hreflang="${escapeXml(lang)}" href="${escapeXml(href)}"/>`,
        );
      }
    }

    parts.push(`  </url>`);
    return parts.join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urlElements,
    '</urlset>',
  ].join('\n');
}

/**
 * Convert a `RobotsConfig` to a robots.txt string.
 *
 * Produces one stanza per rule. Undefined fields within a rule are omitted.
 * `userAgent` defaults to `'*'` when absent.
 *
 * @param config - The robots configuration to serialise.
 * @returns A complete robots.txt string.
 * @internal
 */
function serializeRobots(config: RobotsConfig): string {
  const lines: string[] = [];

  for (const rule of config.rules ?? []) {
    const agents = asArray(rule.userAgent);
    if (agents.length === 0) {
      agents.push('*');
    }

    for (const agent of agents) {
      lines.push(`User-agent: ${agent}`);
    }

    const allows = asArray(rule.allow);
    for (const path of allows) {
      lines.push(`Allow: ${path}`);
    }

    const disallows = asArray(rule.disallow);
    for (const path of disallows) {
      lines.push(`Disallow: ${path}`);
    }

    if (rule.crawlDelay !== undefined) {
      lines.push(`Crawl-delay: ${rule.crawlDelay}`);
    }

    lines.push('');
  }

  const sitemaps = asArray(config.sitemap);
  for (const url of sitemaps) {
    lines.push(`Sitemap: ${url}`);
  }

  if (config.host) {
    lines.push(`Host: ${config.host}`);
  }

  return lines.join('\n').trimEnd() + '\n';
}

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * Register metadata file routes on a Hono application.
 *
 * Checks for convention files in the `server/` directory (the parent of
 * `serverRoutesDir`) and registers GET handlers for each that exists:
 *
 * - `server/sitemap.ts`  → `GET /sitemap.xml`
 * - `server/robots.ts`   → `GET /robots.txt`
 * - `server/manifest.ts` → `GET /manifest.webmanifest` and `GET /manifest.json`
 *
 * Handlers dynamically import the convention file and call its default export.
 * Each handler must be registered before SSR middleware so it takes priority.
 *
 * Routes are only registered when the corresponding file exists — if the file
 * does not exist, the route is not registered and the request falls through to
 * SSR or the SPA.
 *
 * @param app - The Hono application instance. Must be registered before SSR middleware.
 * @param serverRoutesDir - Absolute path to the server routes directory
 *   (e.g. `import.meta.dir + '/server/routes'`). The parent directory (`server/`)
 *   is scanned for convention files.
 *
 * @example
 * ```ts
 * import { registerMetadataRoutes } from '@lastshotlabs/slingshot-ssr'
 *
 * registerMetadataRoutes(app, import.meta.dir + '/server/routes')
 * ```
 */
export function registerMetadataRoutes(app: unknown, serverRoutesDir: string): void {
  const honoApp = app as HonoAppShape;
  // Convention files live adjacent to serverRoutesDir (i.e. in the server/ directory)
  const serverDir = dirname(serverRoutesDir);

  // ── sitemap.xml ──────────────────────────────────────────────────────────────
  const sitemapPath = findConventionTs(serverDir, 'sitemap');
  if (sitemapPath) {
    honoApp.get('/sitemap.xml', async c => {
      try {
        const mod = (await import(sitemapPath)) as Record<string, unknown>;
        const fn = (mod['default'] ?? mod['sitemap']) as
          | (() => Promise<SitemapEntry[]> | SitemapEntry[])
          | undefined;
        if (typeof fn !== 'function') {
          return c.body('Not Found', 404, { 'Content-Type': 'text/plain' });
        }
        const entries = await fn();
        const xml = serializeSitemap(entries);
        return c.body(xml, 200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
      } catch (err) {
        logger.error('sitemap handler threw', { err: String(err) });
        return c.body('Internal Server Error', 500, {
          'Content-Type': 'text/plain',
        });
      }
    });
  }

  // ── robots.txt ───────────────────────────────────────────────────────────────
  const robotsPath = findConventionTs(serverDir, 'robots');
  if (robotsPath) {
    honoApp.get('/robots.txt', async c => {
      try {
        const mod = (await import(robotsPath)) as Record<string, unknown>;
        const fn = (mod['default'] ?? mod['robots']) as
          | (() => Promise<RobotsConfig> | RobotsConfig)
          | undefined;
        if (typeof fn !== 'function') {
          return c.body('Not Found', 404, { 'Content-Type': 'text/plain' });
        }
        const config = await fn();
        const txt = serializeRobots(config);
        return c.body(txt, 200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
      } catch (err) {
        logger.error('robots handler threw', { err: String(err) });
        return c.body('Internal Server Error', 500, {
          'Content-Type': 'text/plain',
        });
      }
    });
  }

  // ── manifest.webmanifest + manifest.json ─────────────────────────────────────
  const manifestPath = findConventionTs(serverDir, 'manifest');
  if (manifestPath) {
    const manifestHandler = async (c: HonoContextShape) => {
      try {
        const mod = (await import(manifestPath)) as Record<string, unknown>;
        const fn = (mod['default'] ?? mod['manifest']) as
          | (() => Promise<Record<string, unknown>> | Record<string, unknown>)
          | undefined;
        if (typeof fn !== 'function') {
          return c.body('Not Found', 404, { 'Content-Type': 'text/plain' });
        }
        const data = await fn();
        const json = JSON.stringify(data);
        return c.body(json, 200, {
          'Content-Type': 'application/manifest+json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
      } catch (err) {
        logger.error('manifest handler threw', { err: String(err) });
        return c.body('Internal Server Error', 500, {
          'Content-Type': 'text/plain',
        });
      }
    };
    honoApp.get('/manifest.webmanifest', manifestHandler);
    honoApp.get('/manifest.json', manifestHandler);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Look for a convention TypeScript file in a directory.
 * Checks `{dir}/{name}.ts`, `{dir}/{name}.tsx`, and `{dir}/{name}.js`.
 * Returns the first match, or `null` when none found.
 *
 * @internal
 */
function findConventionTs(dir: string, name: string): string | null {
  for (const ext of ['ts', 'tsx', 'js']) {
    const candidate = join(dir, `${name}.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
