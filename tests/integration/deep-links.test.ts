import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { createDeepLinksPlugin } from '@lastshotlabs/slingshot-deep-links';
import { getDeepLinksState } from '@lastshotlabs/slingshot-deep-links/testing';
import { createApp } from '../../src/app';
import { createServerFromManifest } from '../../src/lib/createServerFromManifest';

type RunningServer = {
  port: number;
  stop(close?: boolean): void | Promise<void>;
};

const cleanupPaths = new Set<string>();

afterEach(() => {
  for (const path of cleanupPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe('slingshot-deep-links', () => {
  it('serves AASA, assetlinks, and fallback routes in code mode', async () => {
    const { app } = await createApp({
      db: {
        mongo: false,
        redis: false,
        sessions: 'memory',
        cache: 'memory',
        auth: 'memory',
      },
      plugins: [
        createDeepLinksPlugin({
          apple: {
            teamId: 'ABCDE12345',
            bundleId: 'com.lastshotlabs.slingshot',
            paths: ['/share/*'],
          },
          android: {
            packageName: 'com.lastshotlabs.slingshot',
            sha256Fingerprints: [
              'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
            ],
          },
          fallbackBaseUrl: 'https://example.com',
          fallbackRedirects: {
            '/share/*': '/posts/:id',
          },
        }),
      ],
    });

    const aasa = await app.request('/.well-known/apple-app-site-association');
    expect(aasa.status).toBe(200);
    expect(aasa.headers.get('content-type')).toContain('application/json');
    expect(await aasa.json()).toEqual({
      applinks: {
        apps: [],
        details: [
          {
            appID: 'ABCDE12345.com.lastshotlabs.slingshot',
            paths: ['/share/*'],
          },
        ],
      },
    });

    const assetlinks = await app.request('/.well-known/assetlinks.json');
    expect(assetlinks.status).toBe(200);
    expect(await assetlinks.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.lastshotlabs.slingshot',
          sha256_cert_fingerprints: [
            'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
          ],
        },
      },
    ]);

    const fallback = await app.request('/share/post-1');
    expect(fallback.status).toBe(302);
    expect(fallback.headers.get('location')).toBe('https://example.com/posts/post-1');

    expect(getDeepLinksState(app as any)).toMatchObject({
      config: {
        fallbackBaseUrl: 'https://example.com',
      },
    });
  });

  it('boots from a manifest and serves well-known routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-deep-links-'));
    cleanupPaths.add(dir);
    mkdirSync(dir, { recursive: true });

    const manifestPath = join(dir, 'app.manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          manifestVersion: 1,
          db: {
            mongo: false,
            redis: false,
            sessions: 'memory',
            cache: 'memory',
            auth: 'memory',
          },
          plugins: [
            {
              plugin: 'slingshot-deep-links',
              config: {
                apple: {
                  teamId: 'ABCDE12345',
                  bundleId: 'com.lastshotlabs.slingshot',
                  paths: ['/share/*'],
                },
                android: {
                  packageName: 'com.lastshotlabs.slingshot',
                  sha256Fingerprints: [
                    'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
                  ],
                },
              },
            },
          ],
          port: 0,
        },
        null,
        2,
      ),
      'utf8',
    );

    const server = (await createServerFromManifest(manifestPath)) as unknown as RunningServer;
    try {
      const baseUrl = `http://localhost:${server.port}`;
      const aasa = await fetch(`${baseUrl}/.well-known/apple-app-site-association`);
      expect(aasa.status).toBe(200);
      expect(await aasa.json()).toEqual({
        applinks: {
          apps: [],
          details: [
            {
              appID: 'ABCDE12345.com.lastshotlabs.slingshot',
              paths: ['/share/*'],
            },
          ],
        },
      });

      const assetlinks = await fetch(`${baseUrl}/.well-known/assetlinks.json`);
      expect(assetlinks.status).toBe(200);
      expect(await assetlinks.json()).toEqual([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: 'com.lastshotlabs.slingshot',
            sha256_cert_fingerprints: [
              'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
            ],
          },
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });
});
