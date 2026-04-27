import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SlingshotContext } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Mocks for the three dynamic imports bootstrap.ts uses
// ---------------------------------------------------------------------------

const fakeRuntime = { password: { hash: async () => '', verify: async () => true } };
const fakeNodeRuntime = mock(() => fakeRuntime);

mock.module('@lastshotlabs/slingshot-runtime-node', () => ({
  nodeRuntime: fakeNodeRuntime,
}));

const fakeResolveManifestConfig = mock(
  async (_manifest: unknown, _registry?: unknown, _opts?: unknown) => ({
    config: { appName: 'test-bootstrap-app', resolvedStores: {} },
    manifest: { manifestVersion: 1 },
    registry: { resolveHandler: () => null, hasHandler: () => false },
  }),
);

mock.module('@lastshotlabs/slingshot/manifest', () => ({
  resolveManifestConfig: fakeResolveManifestConfig,
}));

const fakeDestroy = mock(async () => {});
const fakeCtx = {
  appName: 'test-bootstrap-app',
  destroy: fakeDestroy,
} as unknown as SlingshotContext;

const fakeCreateApp = mock(async (_config: unknown) => ({ ctx: fakeCtx }));

mock.module('@lastshotlabs/slingshot', () => ({
  createApp: fakeCreateApp,
}));

// Import AFTER mocks are registered
let bootstrap: (typeof import('../src/bootstrap'))['bootstrap'];

describe('bootstrap', () => {
  beforeEach(async () => {
    fakeNodeRuntime.mockClear();
    fakeResolveManifestConfig.mockClear();
    fakeCreateApp.mockClear();
    fakeDestroy.mockClear();
    const mod = await import('../src/bootstrap');
    bootstrap = mod.bootstrap;
  });

  test('uses provided manifest, resolves config, and creates app', async () => {
    const manifest = { manifestVersion: 1, appName: 'test' };
    const result = await bootstrap({ manifest });

    expect(fakeResolveManifestConfig).toHaveBeenCalledWith(manifest, undefined, {
      handlersPath: undefined,
    });
    expect(fakeCreateApp).toHaveBeenCalledTimes(1);
    expect(result.ctx).toBe(fakeCtx);
  });

  test('uses nodeRuntime() as default when config.runtime is not provided', async () => {
    await bootstrap({ manifest: { manifestVersion: 1 } });
    expect(fakeNodeRuntime).toHaveBeenCalledTimes(1);
  });

  test('uses provided runtime instead of nodeRuntime when config.runtime is set', async () => {
    const customRuntime = { password: { hash: async () => '', verify: async () => true } };
    await bootstrap({ manifest: { manifestVersion: 1 }, runtime: customRuntime as never });
    expect(fakeNodeRuntime).not.toHaveBeenCalled();
  });

  test('passes handlersPath option through to resolveManifestConfig', async () => {
    await bootstrap({ manifest: { manifestVersion: 1 }, handlersPath: './handlers' });
    expect(fakeResolveManifestConfig).toHaveBeenCalledWith(expect.anything(), undefined, {
      handlersPath: './handlers',
    });
  });

  test('teardown calls ctx.destroy()', async () => {
    const result = await bootstrap({ manifest: { manifestVersion: 1 } });
    await result.teardown();
    expect(fakeDestroy).toHaveBeenCalledTimes(1);
  });
});
