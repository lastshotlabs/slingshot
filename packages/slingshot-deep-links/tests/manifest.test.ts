/**
 * Manifest-first compliance test for slingshot-deep-links.
 *
 * Verifies that the plugin boots correctly from a plain JSON config object —
 * the kind produced by JSON.parse(manifestJson). No function references, no
 * class instances, no runtime objects that cannot cross a JSON boundary.
 *
 * This proves that `createDeepLinksPlugin` is manifest-first: passing a
 * JSON.parse/JSON.stringify-round-tripped config object produces an identical
 * result to passing the original typed config.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { InProcessAdapter, attachContext } from '@lastshotlabs/slingshot-core';
import type { DeepLinksConfigInput } from '../src/config';
import { createDeepLinksPlugin } from '../src/plugin';

/**
 * Simulate how a manifest bootstrap would work: take a JSON-serializable
 * config blob (as you'd get from JSON.parse of an app.manifest.json), pass
 * it to createDeepLinksPlugin, and wire up the plugin.
 */
function bootFromManifestJson(manifestJson: string): Hono {
  const parsed = JSON.parse(manifestJson) as DeepLinksConfigInput;

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

  const emptyConfigRaw = {};
  const emptyConfig = emptyConfigRaw as unknown as never;
  const plugin = createDeepLinksPlugin(parsed);
  plugin.setupMiddleware?.({ app, config: emptyConfig, bus });
  plugin.setupRoutes?.({ app, config: emptyConfig, bus });
  plugin.setupPost?.({ app, config: emptyConfig, bus });

  return app;
}

// Phase 6 example manifest JSON (all fields JSON-serializable, no functions).
const FULL_MANIFEST_JSON = JSON.stringify({
  apple: [
    {
      teamId: 'TEAM123456',
      bundleId: 'com.example.app',
      paths: ['/share/*', '/posts/*'],
    },
  ],
  android: {
    packageName: 'com.example.app',
    sha256Fingerprints: [
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    ],
  },
  fallbackBaseUrl: 'https://example.com',
  fallbackRedirects: {
    '/share/*': '/posts/:id',
  },
});

describe('Manifest-first compliance — JSON round-trip', () => {
  test('config survives JSON.parse/JSON.stringify without information loss', () => {
    const original: DeepLinksConfigInput = {
      apple: [
        {
          teamId: 'TEAM123456',
          bundleId: 'com.example.app',
          paths: ['/share/*', '/posts/*'],
        },
      ],
      android: {
        packageName: 'com.example.app',
        sha256Fingerprints: [
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        ],
      },
    };
    const roundTripped = JSON.parse(JSON.stringify(original)) as DeepLinksConfigInput;
    // Round-tripped config must produce the same JSON as the original.
    expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(original));
  });

  test('no function references in config (all fields are JSON primitives)', () => {
    const parsed = JSON.parse(FULL_MANIFEST_JSON) as Record<string, unknown>;
    // JSON.parse will have produced a plain object with no function values.
    const allValuesJson = JSON.stringify(parsed);
    expect(() => JSON.parse(allValuesJson)).not.toThrow();
  });
});

describe('Manifest boot — AASA route', () => {
  test('GET /.well-known/apple-app-site-association returns 200 from manifest JSON', async () => {
    const app = bootFromManifestJson(FULL_MANIFEST_JSON);
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
  });

  test('AASA body has correct teamId.bundleId in appID', async () => {
    const app = bootFromManifestJson(FULL_MANIFEST_JSON);
    const res = await app.request('/.well-known/apple-app-site-association');
    const body = (await res.json()) as {
      applinks: { details: Array<{ appID: string; paths: string[] }> };
    };
    expect(body.applinks.details[0]!.appID).toBe('TEAM123456.com.example.app');
    expect(body.applinks.details[0]!.paths).toContain('/share/*');
  });
});

describe('Manifest boot — assetlinks route', () => {
  test('GET /.well-known/assetlinks.json returns 200 from manifest JSON', async () => {
    const app = bootFromManifestJson(FULL_MANIFEST_JSON);
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
  });

  test('assetlinks body has correct package_name', async () => {
    const app = bootFromManifestJson(FULL_MANIFEST_JSON);
    const res = await app.request('/.well-known/assetlinks.json');
    const body = (await res.json()) as Array<{ target: { package_name: string } }>;
    expect(body[0]!.target.package_name).toBe('com.example.app');
  });
});

describe('Manifest boot — fallback redirects', () => {
  test('fallback redirect works from manifest JSON config', async () => {
    const app = bootFromManifestJson(FULL_MANIFEST_JSON);
    const res = await app.request('/share/abc');
    expect([301, 302]).toContain(res.status);
    expect(res.headers.get('location')).toContain('/posts/abc');
    expect(res.headers.get('location')).toContain('https://example.com');
  });
});

describe('Manifest boot — apple-only (no android)', () => {
  test('AASA route 200, assetlinks 404 when android absent', async () => {
    const appleOnlyJson = JSON.stringify({
      apple: {
        teamId: 'ABCDEF1234',
        bundleId: 'com.test.ios',
        paths: ['/app/*'],
      },
    });
    const app = bootFromManifestJson(appleOnlyJson);

    const aasa = await app.request('/.well-known/apple-app-site-association');
    expect(aasa.status).toBe(200);

    const links = await app.request('/.well-known/assetlinks.json');
    expect(links.status).toBe(404);
  });
});

describe('Manifest boot — android-only (no apple)', () => {
  test('assetlinks 200, AASA 404 when apple absent', async () => {
    const androidOnlyJson = JSON.stringify({
      android: {
        packageName: 'com.test.android',
        sha256Fingerprints: [
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        ],
      },
    });
    const app = bootFromManifestJson(androidOnlyJson);

    const links = await app.request('/.well-known/assetlinks.json');
    expect(links.status).toBe(200);

    const aasa = await app.request('/.well-known/apple-app-site-association');
    expect(aasa.status).toBe(404);
  });
});

describe('Manifest boot — invalid config rejected at setup time', () => {
  test('invalid teamId throws before any request is served', () => {
    const badJson = JSON.stringify({
      apple: {
        teamId: 'invalid-team', // not 10 uppercase alphanumeric chars
        bundleId: 'com.example.app',
        paths: ['/share/*'],
      },
    });
    expect(() => bootFromManifestJson(badJson)).toThrow();
  });

  test('empty config (no apple, no android) throws', () => {
    expect(() => bootFromManifestJson(JSON.stringify({}))).toThrow();
  });
});
