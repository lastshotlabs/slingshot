import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  type AppEnv,
  PACKAGE_CAPABILITIES_PREFIX,
  attachContext,
} from '@lastshotlabs/slingshot-core';
import {
  buildAttachmentRequiredGuard,
  buildPollRequiredGuard,
} from '../../src/middleware/peerGuards';

function buildApp(opts: { hasPolls?: boolean; hasAssets?: boolean }) {
  const app = new Hono<AppEnv>();
  const pluginState = new Map<string, unknown>();
  // Mirror what `publishPackageRuntimeState()` does for a registered package —
  // each package's slot is the only canonical signal for `isPackageRegistered()`.
  if (opts.hasPolls) pluginState.set(`${PACKAGE_CAPABILITIES_PREFIX}slingshot-polls`, {});
  if (opts.hasAssets) pluginState.set(`${PACKAGE_CAPABILITIES_PREFIX}slingshot-assets`, {});

  attachContext(app, {
    app,
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus: { on() {}, emit() {}, drain: async () => {} },
  } as unknown as Parameters<typeof attachContext>[1]);

  app.use('*', buildPollRequiredGuard(app));
  app.use('*', buildAttachmentRequiredGuard(app));
  app.post('/messages', (c: Context<AppEnv>) => c.json({ ok: true }));
  return app;
}

async function post(app: ReturnType<typeof buildApp>, body: unknown) {
  return app.request('/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('chat peer guards', () => {
  test('returns 503 when poll field present but polls plugin is absent', async () => {
    const app = buildApp({});
    const res = await post(app, { body: 'hi', poll: { question: 'Ship it?' } });
    expect(res.status).toBe(503);
  });

  test('passes through when poll field present and polls plugin is registered', async () => {
    const app = buildApp({ hasPolls: true });
    const res = await post(app, { body: 'hi', poll: { question: 'Ship it?' } });
    expect(res.status).toBe(200);
  });

  test('returns 503 when attachments are present but assets plugin is absent', async () => {
    const app = buildApp({});
    const res = await post(app, { body: 'hi', attachments: [{ assetId: 'asset-1' }] });
    expect(res.status).toBe(503);
  });

  test('passes through when attachments are present and assets plugin is registered', async () => {
    const app = buildApp({ hasAssets: true });
    const res = await post(app, { body: 'hi', attachments: [{ assetId: 'asset-1' }] });
    expect(res.status).toBe(200);
  });
});
