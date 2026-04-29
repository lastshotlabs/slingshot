import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext } from '@lastshotlabs/slingshot-core';
import {
  AUTH_RUNTIME_KEY,
  getAuthRuntimeContext,
  getAuthRuntimeContextOrNull,
  getAuthRuntimeFromRequest,
  getAuthRuntimeFromRequestOrNull,
} from '../../src/runtime';
import { makeTestRuntime } from '../helpers/runtime';

describe('auth runtime accessors', () => {
  test('resolve auth runtime from app, pluginState carrier, and request context', async () => {
    const runtime = makeTestRuntime();
    const pluginState = new Map<string, unknown>([[AUTH_RUNTIME_KEY, runtime]]);
    const app = new Hono();

    attachContext(app, {
      app,
      pluginState,
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
      bus: { on() {}, emit() {}, drain: async () => {} },
    } as unknown as Parameters<typeof attachContext>[1]);

    expect(getAuthRuntimeContext(pluginState)).toBe(runtime);
    expect(getAuthRuntimeContext({ pluginState })).toBe(runtime);
    expect(getAuthRuntimeContextOrNull(app)).toBe(runtime);

    app.get('/runtime', c => {
      expect(getAuthRuntimeFromRequest(c)).toBe(runtime);
      return c.json({ ok: true });
    });

    const response = await app.request('/runtime');
    expect(response.status).toBe(200);
  });

  test('request accessor can resolve runtime published directly on Hono context', async () => {
    const runtime = makeTestRuntime();
    const app = new Hono<{ Variables: { [AUTH_RUNTIME_KEY]: typeof runtime } }>();

    app.use('*', async (c, next) => {
      c.set(AUTH_RUNTIME_KEY, runtime);
      await next();
    });
    app.get('/runtime', c => {
      expect(getAuthRuntimeFromRequestOrNull(c)).toBe(runtime);
      expect(getAuthRuntimeFromRequest(c)).toBe(runtime);
      return c.json({ ok: true });
    });

    const response = await app.request('/runtime');
    expect(response.status).toBe(200);
  });

  test('nullable accessor returns null and throwing accessor fails loudly when auth is absent', () => {
    const app = new Hono();

    expect(getAuthRuntimeContextOrNull(app)).toBeNull();
    expect(() => getAuthRuntimeContext(app)).toThrow(
      'auth runtime context is not available in pluginState',
    );
  });
});
