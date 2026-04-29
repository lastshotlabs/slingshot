/**
 * Edge-case tests for Lambda bootstrap: cold start caching, handler resolution
 * from manifest, module caching behavior, and configuration propagation.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SlingshotContext } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Mocks for bootstrap dependencies
// ---------------------------------------------------------------------------

const fakeRuntime = { password: { hash: async () => '', verify: async () => true } };
const fakeNodeRuntime = mock(() => fakeRuntime);

mock.module('@lastshotlabs/slingshot-runtime-node', () => ({
  nodeRuntime: fakeNodeRuntime,
}));

let resolveManifestCallCount = 0;
let resolveManifestConfigImpl = mock(
  async (_manifest: unknown, _registry?: unknown, _opts?: unknown) => {
    resolveManifestCallCount++;
    return {
      config: { appName: 'test-bootstrap-edge', resolvedStores: {} },
      manifest: { manifestVersion: 1 },
      registry: { resolveHandler: () => null, hasHandler: () => false },
    };
  },
);

mock.module('@lastshotlabs/slingshot/manifest', () => ({
  resolveManifestConfig: resolveManifestConfigImpl,
}));

const fakeDestroy = mock(async () => {});
const fakeCtx = {
  appName: 'test-bootstrap-edge',
  destroy: fakeDestroy,
} as unknown as SlingshotContext;

const fakeCreateApp = mock(async (_config: unknown) => ({ ctx: fakeCtx }));

mock.module('@lastshotlabs/slingshot', () => ({
  createApp: fakeCreateApp,
}));

describe('bootstrap edge cases', () => {
  beforeEach(async () => {
    fakeNodeRuntime.mockClear();
    resolveManifestConfigImpl.mockClear();
    fakeCreateApp.mockClear();
    fakeDestroy.mockClear();
    resolveManifestCallCount = 0;
  });

  test('uses default nodeRuntime when no runtime is provided', async () => {
    const { bootstrap } = await import('../src/bootstrap');
    await bootstrap({ manifest: { manifestVersion: 1, appName: 'test' } });
    expect(fakeNodeRuntime).toHaveBeenCalledTimes(1);
  });

  test('accepts custom runtime provider and does not call nodeRuntime', async () => {
    const { bootstrap } = await import('../src/bootstrap');
    const customRuntime = { password: { hash: async () => '', verify: async () => true } };
    await bootstrap({
      manifest: { manifestVersion: 1, appName: 'test' },
      runtime: customRuntime as never,
    });
    expect(fakeNodeRuntime).not.toHaveBeenCalled();
  });

  test('passes handlersPath to resolveManifestConfig', async () => {
    const { bootstrap } = await import('../src/bootstrap');
    await bootstrap({
      manifest: { manifestVersion: 1, appName: 'test' },
      handlersPath: './custom-handlers.ts',
    });
    expect(resolveManifestConfigImpl).toHaveBeenCalledWith(expect.anything(), undefined, {
      handlersPath: './custom-handlers.ts',
    });
  });

  test('teardown calls ctx.destroy and resolves', async () => {
    const { bootstrap } = await import('../src/bootstrap');
    const result = await bootstrap({ manifest: { manifestVersion: 1, appName: 'test' } });
    await result.teardown();
    expect(fakeDestroy).toHaveBeenCalledTimes(1);
  });

  test('repeated bootstrap calls re-resolve config each time', async () => {
    const { bootstrap } = await import('../src/bootstrap');
    await bootstrap({ manifest: { manifestVersion: 1, appName: 'test' } });
    await bootstrap({ manifest: { manifestVersion: 1, appName: 'test' } });
    // resolveManifestConfig should be called each time
    expect(resolveManifestCallCount).toBe(2);
  });

  test('returns ctx with correct appName from config', async () => {
    const { bootstrap } = await import('../src/bootstrap');
    const result = await bootstrap({ manifest: { manifestVersion: 1, appName: 'test' } });
    expect(result.ctx?.appName).toBe('test-bootstrap-edge');
  });
});
