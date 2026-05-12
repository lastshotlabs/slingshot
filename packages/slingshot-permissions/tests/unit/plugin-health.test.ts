import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext } from '@lastshotlabs/slingshot-core';
import { createPermissionsPackage } from '../../src/plugin';
import type { PermissionsHealth } from '../../src/public';

function asNever<T>(v: T): never {
  return v as never;
}

function readHealth(ctx: { pluginState: Map<string, unknown> }): PermissionsHealth | null {
  const slot = ctx.pluginState.get(
    'slingshot:package:capabilities:slingshot-permissions',
  ) as { health?: () => PermissionsHealth } | undefined;
  if (!slot?.health) return null;
  return slot.health();
}

describe('createPermissionsPackage health capability', () => {
  test('returns unhealthy before setupMiddleware has run (no adapter resolved, no slot)', () => {
    const app = new Hono();
    const ctx = { pluginState: new Map<string, unknown>() };
    attachContext(app, ctx as never);
    expect(readHealth(ctx)).toBeNull();
  });

  test('returns healthy after setupMiddleware resolves the memory adapter', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map<string, unknown>() };
    attachContext(app, ctx as never);

    const pkg = createPermissionsPackage();
    await pkg.setupMiddleware?.(
      asNever({
        app,
        config: {
          resolvedStores: { authStore: 'memory' },
          storeInfra: {},
        },
        bus: {},
      }),
    );

    const health = readHealth(ctx);
    expect(health).not.toBeNull();
    expect(health!.status).toBe('healthy');
    expect(health!.details.adapterAvailable).toBe(true);
    expect(health!.details.evaluator).toEqual({
      queryTimeoutCount: 0,
      groupExpansionErrorCount: 0,
      lastQueryTimeoutAt: null,
      lastGroupExpansionErrorAt: null,
    });
    expect(health!.details.adapter).toBeUndefined();
    expect(ctx.pluginState.has('slingshot:package:capabilities:slingshot-permissions')).toBe(true);
  });
});
