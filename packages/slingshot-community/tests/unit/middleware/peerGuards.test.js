import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext } from '@lastshotlabs/slingshot-core';
import {
  buildAttachmentRequiredGuard,
  buildPollRequiredGuard,
} from '../../../src/middleware/peerGuards';

function buildApp(opts) {
  const app = new Hono();
  const pluginState = new Map();
  if (opts.hasPolls) pluginState.set('slingshot-polls', {});
  if (opts.hasAssets) pluginState.set('slingshot-assets', {});
  attachContext(app, {
    app,
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus: { on() {}, emit() {}, drain: async () => {} },
  });
  app.use('*', buildPollRequiredGuard(app));
  app.use('*', buildAttachmentRequiredGuard(app));
  app.post('/threads', c => c.json({ ok: true }));
  return app;
}
async function post(app, body) {
  return app.request('/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
describe('buildPollRequiredGuard', () => {
  test('passes through when no poll field in body', async () => {
    const app = buildApp({});
    const res = await post(app, { title: 'Hello' });
    expect(res.status).toBe(200);
  });
  test('returns 503 when poll field present but slingshot-polls not registered', async () => {
    const app = buildApp({});
    const res = await post(app, { title: 'Hello', poll: { question: 'Yes or no?' } });
    expect(res.status).toBe(503);
  });
  test('passes through when poll field present and slingshot-polls registered', async () => {
    const app = buildApp({ hasPolls: true });
    const res = await post(app, { title: 'Hello', poll: { question: 'Yes or no?' } });
    expect(res.status).toBe(200);
  });
  test('passes through on malformed JSON body', async () => {
    const app = buildApp({});
    const res = await app.request('/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(200);
  });
});
describe('buildAttachmentRequiredGuard', () => {
  test('passes through when no attachments in body', async () => {
    const app = buildApp({});
    const res = await post(app, { title: 'Hello' });
    expect(res.status).toBe(200);
  });
  test('passes through when attachments is empty array', async () => {
    const app = buildApp({});
    const res = await post(app, { title: 'Hello', attachments: [] });
    expect(res.status).toBe(200);
  });
  test('returns 503 when attachments present but slingshot-assets not registered', async () => {
    const app = buildApp({});
    const res = await post(app, { title: 'Hello', attachments: [{ url: 'a.png' }] });
    expect(res.status).toBe(503);
  });
  test('passes through when attachments present and slingshot-assets registered', async () => {
    const app = buildApp({ hasAssets: true });
    const res = await post(app, { title: 'Hello', attachments: [{ url: 'a.png' }] });
    expect(res.status).toBe(200);
  });
});
