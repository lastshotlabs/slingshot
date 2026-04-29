import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { PERMISSIONS_STATE_KEY, attachContext } from '@lastshotlabs/slingshot-core';
import { createPermissionsPlugin } from '../../src/plugin';

function asNever<T>(v: T): never {
  return v as never;
}

describe('createPermissionsPlugin getHealth()', () => {
  test('returns unhealthy before setupMiddleware has run (no adapter resolved)', () => {
    const plugin = createPermissionsPlugin();
    const health = plugin.getHealth();
    expect(health.status).toBe('unhealthy');
    expect(health.details.adapterAvailable).toBe(false);
    expect(health.details.adapterName).toBeNull();
    expect(health.details.evaluator).toBeNull();
    expect(health.details.adapter).toBeUndefined();
  });

  test('returns healthy after setupMiddleware resolves the memory adapter', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();
    await plugin.setupMiddleware?.(
      asNever({
        app,
        config: {
          resolvedStores: { authStore: 'memory' },
          storeInfra: {},
        },
        bus: {},
      }),
    );

    const health = plugin.getHealth();
    expect(health.status).toBe('healthy');
    expect(health.details.adapterAvailable).toBe(true);
    expect(health.details.evaluator).toEqual({
      queryTimeoutCount: 0,
      groupExpansionErrorCount: 0,
      lastQueryTimeoutAt: null,
      lastGroupExpansionErrorAt: null,
    });
    expect(health.details.adapter).toBeUndefined();
    expect(ctx.pluginState.has(PERMISSIONS_STATE_KEY)).toBe(true);
  });
});
