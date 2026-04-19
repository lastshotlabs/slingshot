import { describe, expect, it } from 'bun:test';
import { attachContext, createRouter } from '@lastshotlabs/slingshot-core';
import type { CacheAdapter } from '@lastshotlabs/slingshot-core';

/**
 * Documents the defense-in-depth behavior of bustCache/bustCachePattern:
 * both functions delete from ALL four cache backends regardless of which
 * store is configured, because cacheResponse() allows per-route store
 * overrides. Each adapter's isReady() check gates the operation — adapters
 * that aren't ready are skipped gracefully.
 *
 * After Phase 1 singleton elimination, bustCache/bustCachePattern accept an
 * optional `app` parameter for app name resolution. When omitted they
 * default to "Core API".
 */

function createTrackingAdapter(name: string, calledStores: string[], ready = true): CacheAdapter {
  return {
    name,
    async get() {
      return null;
    },
    async set() {},
    async del() {
      calledStores.push(name);
    },
    async delPattern() {
      calledStores.push(name);
    },
    isReady() {
      return ready;
    },
  };
}

describe('bustCache defense-in-depth', () => {
  it('bustCache calls storeDel for all four backends', async () => {
    const calledStores: string[] = [];
    const app = createRouter();
    attachContext(app, {
      app,
      config: { appName: 'Test App' },
      cacheAdapters: new Map([
        ['memory', createTrackingAdapter('memory', calledStores, true)],
        ['redis', createTrackingAdapter('redis', calledStores, false)],
        ['sqlite', createTrackingAdapter('sqlite', calledStores, false)],
        ['mongo', createTrackingAdapter('mongo', calledStores, false)],
      ]),
    } as any);

    const { bustCache } = await import('../../src/framework/middleware/cacheResponse');
    await bustCache('some-key', app);

    expect(calledStores).toContain('memory');
    expect(calledStores).not.toContain('redis');
    expect(calledStores).not.toContain('sqlite');
    expect(calledStores).not.toContain('mongo');
  });

  it('bustCachePattern calls storeDelPattern for all four backends', async () => {
    const calledStores: string[] = [];
    const app = createRouter();
    attachContext(app, {
      app,
      config: { appName: 'Test App' },
      cacheAdapters: new Map([
        ['memory', createTrackingAdapter('memory', calledStores, true)],
        ['redis', createTrackingAdapter('redis', calledStores, false)],
        ['sqlite', createTrackingAdapter('sqlite', calledStores, false)],
        ['mongo', createTrackingAdapter('mongo', calledStores, false)],
      ]),
    } as any);

    const { bustCachePattern } = await import('../../src/framework/middleware/cacheResponse');
    await bustCachePattern('prefix:*', app);

    expect(calledStores).toContain('memory');
    expect(calledStores).not.toContain('redis');
  });
});
