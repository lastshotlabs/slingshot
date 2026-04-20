import { describe, expect, it } from 'bun:test';
import type { AppManifest } from '../../src/lib/manifest';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';
import { manifestToSsgConfig } from '../../src/lib/manifestToSsgConfig';

describe('manifestToSsgConfig', () => {
  it('inherits shared SSR fields and resolves the renderer handler ref', () => {
    const registry = createManifestHandlerRegistry();
    const renderer = {
      resolve: async () => null,
      render: async () => new Response('ok'),
      renderChain: async () => new Response('ok'),
    };
    registry.registerHandler('ssrRenderer', () => renderer);

    const manifest: AppManifest = {
      manifestVersion: 1,
      ssr: {
        renderer: { handler: 'ssrRenderer' },
        serverRoutesDir: './server/routes',
        assetsManifest: './dist/client/.vite/manifest.json',
      },
      ssg: {
        outDir: './dist/static',
        concurrency: 8,
        clientEntry: 'src/client/main.tsx',
      },
    };

    const result = manifestToSsgConfig(manifest, registry, {
      baseDir: 'C:\\apps\\slingshot-example',
    });

    expect(result.renderer).toBe(renderer);
    expect(result.config).toEqual({
      serverRoutesDir: 'C:\\apps\\slingshot-example\\server\\routes',
      assetsManifest: 'C:\\apps\\slingshot-example\\dist\\client\\.vite\\manifest.json',
      outDir: 'C:\\apps\\slingshot-example\\dist\\static',
      concurrency: 8,
      clientEntry: 'src/client/main.tsx',
    });
  });

  it('falls back to ssr.staticDir when ssg.outDir is omitted', () => {
    const registry = createManifestHandlerRegistry();
    const renderer = {
      resolve: async () => null,
      render: async () => new Response('ok'),
      renderChain: async () => new Response('ok'),
    };
    registry.registerHandler('ssrRenderer', () => renderer);

    const manifest: AppManifest = {
      manifestVersion: 1,
      ssr: {
        renderer: { handler: 'ssrRenderer' },
        serverRoutesDir: './server/routes',
        assetsManifest: './dist/client/.vite/manifest.json',
        staticDir: './dist/static',
      },
    };

    const result = manifestToSsgConfig(manifest, registry, {
      baseDir: 'C:\\apps\\slingshot-example',
    });

    expect(result.config.outDir).toBe('C:\\apps\\slingshot-example\\dist\\static');
  });

  it('rejects manifests that explicitly disable SSG', () => {
    const manifest: AppManifest = {
      manifestVersion: 1,
      ssg: {
        enabled: false,
      },
    };

    expect(() => manifestToSsgConfig(manifest)).toThrow('manifest.ssg.enabled is false');
  });

  it('throws when renderer handler ref is missing (requireHandlerRef — line 44)', () => {
    // No ssg.renderer and no ssr.renderer
    const manifest: AppManifest = {
      manifestVersion: 1,
      ssr: {
        serverRoutesDir: './server/routes',
        assetsManifest: './dist/manifest.json',
        // renderer intentionally omitted — will be undefined
      } as any,
    };

    expect(() => manifestToSsgConfig(manifest)).toThrow(
      '[manifestToSsgConfig] Missing required handler ref',
    );
  });

  it('throws when assetsManifest string is missing (requireString — line 52)', () => {
    const registry = createManifestHandlerRegistry();
    const renderer = {
      resolve: async () => null,
      render: async () => new Response('ok'),
      renderChain: async () => new Response('ok'),
    };
    registry.registerHandler('ssrRenderer', () => renderer);

    const manifest: AppManifest = {
      manifestVersion: 1,
      ssr: {
        renderer: { handler: 'ssrRenderer' },
        serverRoutesDir: './server/routes',
        // assetsManifest intentionally omitted
      } as any,
    };

    expect(() => manifestToSsgConfig(manifest, registry)).toThrow(
      '[manifestToSsgConfig] Missing required string value',
    );
  });

  it('rejects inline JSON assets manifest (lines 92-93)', () => {
    const registry = createManifestHandlerRegistry();
    const renderer = {
      resolve: async () => null,
      render: async () => new Response('ok'),
      renderChain: async () => new Response('ok'),
    };
    registry.registerHandler('ssrRenderer', () => renderer);

    const manifest: AppManifest = {
      manifestVersion: 1,
      ssr: {
        renderer: { handler: 'ssrRenderer' },
        serverRoutesDir: './server/routes',
        // Inline JSON object as string (starts with "{")
        assetsManifest: '{"chunks":{"main":{"file":"main.js"}}}',
      },
    };

    expect(() => manifestToSsgConfig(manifest, registry)).toThrow(
      'Inline JSON assets manifests are not supported for SSG builds',
    );
  });
});
