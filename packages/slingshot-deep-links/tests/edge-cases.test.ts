/**
 * Edge case tests for slingshot-deep-links.
 *
 * Covers: very long path lists, special characters in paths, null/undefined
 * in nested config objects, boundary values in fallback expansion, and
 * unusual but valid configurations.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { InProcessAdapter, attachContext } from '@lastshotlabs/slingshot-core';
import { buildAppleAasaBody } from '../src/aasa';
import { buildAssetlinksBody } from '../src/assetlinks';
import { compileDeepLinksConfig, deepLinksConfigSchema } from '../src/config';
import { expandFallback } from '../src/fallback';
import { createDeepLinksPlugin } from '../src/plugin';

function bootApp(config: Parameters<typeof createDeepLinksPlugin>[0]): Hono {
  const app = new Hono();
  const bus = new InProcessAdapter();

  attachContext(app, {
    app,
    pluginState: new Map(),
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
  } as unknown as Parameters<typeof attachContext>[1]);

  const plugin = createDeepLinksPlugin(config);
  const emptyConfig = {} as unknown as never;
  plugin.setupMiddleware?.({ app, config: emptyConfig, bus });
  plugin.setupRoutes?.({ app, config: emptyConfig, bus });
  plugin.setupPost?.({ app, config: emptyConfig, bus });

  return app;
}

const FP =
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

// ── Very long path lists ─────────────────────────────────────────

describe('Very long path lists', () => {
  test('Apple config accepts a large number of paths', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `/route-${i}/*`);
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths },
    });
    expect(result.success).toBe(true);
  });

  test('AASA body includes all paths from a large path list', () => {
    const paths = Array.from({ length: 100 }, (_, i) => `/path-${i}/*`);
    const body = buildAppleAasaBody([{ teamId: 'TEAM123456', bundleId: 'com.example.app', paths }]);
    expect(body).not.toBeNull();
    expect(body!.applinks.details[0]!.paths).toHaveLength(100);
  });

  test('AASA route responds with all 200 paths in the JSON body', async () => {
    const paths = Array.from({ length: 200 }, (_, i) => `/p${i}/*`);
    const app = bootApp({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths },
    });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applinks: { details: Array<{ paths: string[] }> };
    };
    expect(body.applinks.details[0]!.paths).toHaveLength(200);
  });

  test('multiple Apple bundles each with many paths', () => {
    const bundles = Array.from({ length: 10 }, (_, i) => ({
      teamId: 'AAABBBCCCC',
      bundleId: `com.example.app${i}`,
      paths: Array.from({ length: 50 }, (_, j) => `/bundle${i}-path${j}/*`),
    }));
    const result = deepLinksConfigSchema.safeParse({ apple: bundles });
    expect(result.success).toBe(true);
  });
});

// ── Special characters in paths ──────────────────────────────────

describe('Special characters in paths', () => {
  test('accepts paths with URL-encoded segments', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: 'AAABBBCCCC',
        bundleId: 'com.example.app',
        paths: ['/share/%E4%B8%AD%E6%96%87/*'],
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts paths with hyphens and underscores', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: 'AAABBBCCCC',
        bundleId: 'com.example.app',
        paths: ['/my-path_segment/sub-route/*'],
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts root path /', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: 'AAABBBCCCC',
        bundleId: 'com.example.app',
        paths: ['/'],
      },
    });
    expect(result.success).toBe(true);
  });

  test('paths with query-string-like segments are accepted (they are just path patterns)', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: 'AAABBBCCCC',
        bundleId: 'com.example.app',
        paths: ['/share?ref=app'],
      },
    });
    // Path pattern schema only requires starting with /
    expect(result.success).toBe(true);
  });

  test('AASA body preserves paths with special characters verbatim', () => {
    const paths = ['/a-b_c/d%20e/*'];
    const body = buildAppleAasaBody([{ teamId: 'TEAM123456', bundleId: 'com.example.app', paths }]);
    expect(body!.applinks.details[0]!.paths).toEqual(paths);
  });
});

// ── Null/undefined in nested config objects ──────────────────────

describe('Null/undefined in nested config objects', () => {
  test('rejects null as apple value', () => {
    const result = deepLinksConfigSchema.safeParse({ apple: null });
    expect(result.success).toBe(false);
  });

  test('rejects null as android value', () => {
    const result = deepLinksConfigSchema.safeParse({ android: null });
    expect(result.success).toBe(false);
  });

  test('accepts undefined apple with defined android', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: undefined,
      android: { packageName: 'com.example.app', sha256Fingerprints: [FP] },
    });
    expect(result.success).toBe(true);
  });

  test('rejects null in paths array', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: 'AAABBBCCCC',
        bundleId: 'com.example.app',
        paths: [null],
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects undefined in paths array', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: 'AAABBBCCCC',
        bundleId: 'com.example.app',
        paths: [undefined],
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects null as sha256Fingerprints entry', () => {
    const result = deepLinksConfigSchema.safeParse({
      android: { packageName: 'com.example.app', sha256Fingerprints: [null] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects undefined teamId', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: undefined,
        bundleId: 'com.example.app',
        paths: ['/'],
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects undefined bundleId', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: 'AAABBBCCCC',
        bundleId: undefined,
        paths: ['/'],
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects undefined packageName', () => {
    const result = deepLinksConfigSchema.safeParse({
      android: {
        packageName: undefined,
        sha256Fingerprints: [FP],
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects extra unknown fields (strict schema)', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: 'AAABBBCCCC',
        bundleId: 'com.example.app',
        paths: ['/'],
        unknownField: 'surprise',
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects extra top-level unknown fields (strict schema)', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: {
        teamId: 'AAABBBCCCC',
        bundleId: 'com.example.app',
        paths: ['/'],
      },
      bogusTopLevel: true,
    });
    expect(result.success).toBe(false);
  });
});

// ── Fallback expansion edge cases ────────────────────────────────

describe('Fallback expansion edge cases', () => {
  test('handles tail with special characters', () => {
    const result = expandFallback('/share/*', '/posts/:id', '/share/hello%20world');
    expect(result).toBe('/posts/hello%20world');
  });

  test('handles very long tail segment', () => {
    const longTail = 'a'.repeat(2000);
    const result = expandFallback('/s/*', '/t/:id', `/s/${longTail}`);
    expect(result).toBe(`/t/${longTail}`);
  });

  test('handles tail with multiple slashes', () => {
    const result = expandFallback('/a/*', '/b/:id', '/a/x/y/z');
    expect(result).toBe('/b/x/y/z');
  });

  test('returns null for path that matches prefix exactly (no trailing content)', () => {
    // actualPath = "/share/" means tail = "" after stripping "/share/"
    expect(expandFallback('/share/*', '/posts/:id', '/share/')).toBeNull();
  });

  test('returns null for path shorter than prefix', () => {
    expect(expandFallback('/share/*', '/posts/:id', '/sha')).toBeNull();
  });

  test('handles target without :id placeholder', () => {
    const result = expandFallback('/old/*', '/new-page', '/old/anything');
    expect(result).toBe('/new-page');
  });

  test('handles tail with unicode characters', () => {
    const result = expandFallback('/share/*', '/posts/:id', '/share/café');
    expect(result).not.toBeNull();
    expect(result).toContain('café');
  });

  test('handles source with nested prefix', () => {
    const result = expandFallback('/api/v2/share/*', '/posts/:id', '/api/v2/share/123');
    expect(result).toBe('/posts/123');
  });

  test('returns null when path has same prefix but different casing', () => {
    // Path matching is case-sensitive
    expect(expandFallback('/Share/*', '/posts/:id', '/share/123')).toBeNull();
  });
});

// ── compileDeepLinksConfig edge cases ────────────────────────────

describe('compileDeepLinksConfig edge cases', () => {
  test('single apple object is normalized to array of length 1', () => {
    const config = compileDeepLinksConfig({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
    });
    expect(Array.isArray(config.apple)).toBe(true);
    expect(config.apple).toHaveLength(1);
  });

  test('fallback-only config (no apple, no android) with redirects is valid', () => {
    // Schema requires at least one of apple/android/fallbackRedirects
    const result = deepLinksConfigSchema.safeParse({
      fallbackBaseUrl: 'https://example.com',
      fallbackRedirects: { '/old/*': '/new/:id' },
    });
    expect(result.success).toBe(true);
  });

  test('compiled config is deeply frozen', () => {
    const config = compileDeepLinksConfig({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.apple)).toBe(true);
  });

  test('empty fallbackRedirects object is accepted', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
      fallbackBaseUrl: 'https://example.com',
      fallbackRedirects: {},
    });
    expect(result.success).toBe(true);
  });
});

// ── AASA builder edge cases ──────────────────────────────────────

describe('AASA builder edge cases', () => {
  test('handles bundleId with many segments', () => {
    const body = buildAppleAasaBody([
      {
        teamId: 'ABCDEF1234',
        bundleId: 'com.example.division.product.variant',
        paths: ['/'],
      },
    ]);
    expect(body!.applinks.details[0]!.appID).toBe(
      'ABCDEF1234.com.example.division.product.variant',
    );
  });

  test('handles bundleId with hyphens and underscores', () => {
    const body = buildAppleAasaBody([
      {
        teamId: 'ABCDEF1234',
        bundleId: 'com.my-company.ios_app',
        paths: ['/'],
      },
    ]);
    expect(body!.applinks.details[0]!.appID).toBe('ABCDEF1234.com.my-company.ios_app');
  });

  test('each detail entry has its own paths, not shared', () => {
    const body = buildAppleAasaBody([
      { teamId: 'TEAM123456', bundleId: 'com.a.app', paths: ['/a/*'] },
      { teamId: 'TEAM123456', bundleId: 'com.b.app', paths: ['/b/*'] },
    ]);
    expect(body!.applinks.details[0]!.paths).toEqual(['/a/*']);
    expect(body!.applinks.details[1]!.paths).toEqual(['/b/*']);
  });
});

// ── Asset links builder edge cases ───────────────────────────────

describe('Asset links builder edge cases', () => {
  test('handles single fingerprint', () => {
    const body = buildAssetlinksBody({
      packageName: 'com.example.app',
      sha256Fingerprints: [FP],
    });
    expect(body![0]!.target.sha256_cert_fingerprints).toHaveLength(1);
  });

  test('handles many fingerprints', () => {
    const fingerprints = Array.from({ length: 10 }, (_, i) => {
      // Vary the first byte to create distinct fingerprints
      const hex = i.toString(16).toUpperCase().padStart(2, '0');
      return `${hex}:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99`;
    });
    const body = buildAssetlinksBody({
      packageName: 'com.example.app',
      sha256Fingerprints: fingerprints,
    });
    expect(body![0]!.target.sha256_cert_fingerprints).toHaveLength(10);
  });
});

// ── Route integration edge cases ─────────────────────────────────

describe('Route integration edge cases', () => {
  test('AASA response is valid JSON even with many bundles and paths', async () => {
    const bundles = Array.from({ length: 5 }, (_, i) => ({
      teamId: 'AAABBBCCCC',
      bundleId: `com.example.app${i}`,
      paths: Array.from({ length: 20 }, (_, j) => `/b${i}p${j}/*`),
    }));

    const app = bootApp({ apple: bundles });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      applinks: { details: Array<{ appID: string; paths: string[] }> };
    };
    expect(body.applinks.details).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(body.applinks.details[i]!.paths).toHaveLength(20);
    }
  });

  test('fallback redirect with URL-encoded path segment', async () => {
    const app = bootApp({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/share/*'] },
      fallbackBaseUrl: 'https://example.com',
      fallbackRedirects: { '/share/*': '/posts/:id' },
    });
    const res = await app.request('/share/hello%20world');
    expect([301, 302]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    // The framework decodes the path before routing, so the redirect
    // location contains the decoded form.
    expect(location).toContain('hello');
    expect(location).toContain('world');
  });

  test('plugin name is consistent and non-empty', () => {
    const plugin = createDeepLinksPlugin({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
    });
    expect(plugin.name).toBeTruthy();
    expect(typeof plugin.name).toBe('string');
  });
});
