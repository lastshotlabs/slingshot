import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  attachContext,
  createInProcessAdapter,
  getEmbedsPeerOrNull,
} from '@lastshotlabs/slingshot-core';
import { createEmbedsPlugin } from '../src/plugin';

async function bootEmbedsApp() {
  const app = new Hono();
  const plugin = createEmbedsPlugin();
  await plugin.setupRoutes?.({
    app: app as never,
    config: {} as never,
    bus: createInProcessAdapter(),
  });
  return app;
}

describe('slingshot-embeds smoke', () => {
  test('rejects invalid JSON request bodies', async () => {
    const app = await bootEmbedsApp();

    const response = await app.request('/embeds/unfurl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  test('rejects localhost URLs through SSRF validation', async () => {
    const app = await bootEmbedsApp();

    const response = await app.request('/embeds/unfurl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('URL rejected'),
    });
  });

  test('rejects mountPath values that do not start with a slash', () => {
    expect(() => createEmbedsPlugin({ mountPath: 'embeds' })).toThrow();
  });

  test('publishes an embeds peer when pluginState is available', async () => {
    const app = new Hono();
    attachContext(app, {
      app,
      pluginState: new Map<string, unknown>(),
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
      bus: createInProcessAdapter(),
    } as never);

    const plugin = createEmbedsPlugin();
    await plugin.setupRoutes?.({
      app: app as never,
      config: {} as never,
      bus: createInProcessAdapter(),
    });

    const peer = getEmbedsPeerOrNull(app);
    expect(peer).not.toBeNull();
    await expect(peer?.unfurl(['http://localhost'])).resolves.toEqual([]);
  });
});
