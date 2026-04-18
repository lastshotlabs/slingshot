import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext, getContext } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import {
  freezeEntityPolicyRegistry,
  getEntityPolicyResolver,
  registerEntityPolicy,
} from '../../src/policy';

function createTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const pluginState = new Map<string, unknown>();
  const ctx = {
    config: null as unknown,
    plugins: [],
    pluginState,
    clear() {
      pluginState.clear();
      return Promise.resolve();
    },
  } as unknown as Parameters<typeof attachContext>[1];
  attachContext(app, ctx);
  return app;
}

describe('registerEntityPolicy', () => {
  test('register and retrieve a resolver', () => {
    const app = createTestApp();
    const resolver = () => Promise.resolve(true);
    registerEntityPolicy(app, 'test:policy', resolver);
    expect(getEntityPolicyResolver(app, 'test:policy')).toBe(resolver);
  });

  test('duplicate registration throws', () => {
    const app = createTestApp();
    registerEntityPolicy(app, 'test:dup', () => Promise.resolve(true));
    expect(() => {
      registerEntityPolicy(app, 'test:dup', () => Promise.resolve(false));
    }).toThrow(/already registered/);
  });

  test('registration after freeze throws', () => {
    const app = createTestApp();
    registerEntityPolicy(app, 'test:before', () => Promise.resolve(true));
    freezeEntityPolicyRegistry(app);
    expect(() => {
      registerEntityPolicy(app, 'test:after', () => Promise.resolve(false));
    }).toThrow(/frozen/);
  });

  test('two separate apps have independent registries (Rule 3)', () => {
    const app1 = createTestApp();
    const app2 = createTestApp();
    registerEntityPolicy(app1, 'app1:policy', () => Promise.resolve(true));
    expect(getEntityPolicyResolver(app1, 'app1:policy')).toBeDefined();
    expect(getEntityPolicyResolver(app2, 'app1:policy')).toBeUndefined();
  });

  test('unregistered key returns undefined', () => {
    const app = createTestApp();
    expect(getEntityPolicyResolver(app, 'nonexistent')).toBeUndefined();
  });

  test('ctx.clear() resets the registry', async () => {
    const app = createTestApp();
    registerEntityPolicy(app, 'test:cleared', () => Promise.resolve(true));
    expect(getEntityPolicyResolver(app, 'test:cleared')).toBeDefined();
    const ctx = getContext(app);
    await ctx.clear();
    expect(getEntityPolicyResolver(app, 'test:cleared')).toBeUndefined();
  });
});
