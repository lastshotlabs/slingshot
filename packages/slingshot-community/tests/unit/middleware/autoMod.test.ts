import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import { createAutoModMiddleware } from '../../../src/middleware/autoMod';
import type { ModerationDecision } from '../../../src/types/config';
import type { Report } from '../../../src/types/models';
import { setVar } from './_helpers';

type ReportAdapter = EntityAdapter<Report, Record<string, unknown>, Record<string, unknown>>;

function stubReportAdapter() {
  const created: Record<string, unknown>[] = [];
  const adapter = {
    create: async (data: Record<string, unknown>) => {
      created.push(data);
      return { id: 'r1', ...data } as unknown as Report;
    },
  } as unknown as ReportAdapter;
  return { adapter, created };
}

function buildApp(
  hook: (c: unknown) => ModerationDecision | Promise<ModerationDecision>,
  reportAdapter: ReportAdapter,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    setVar(c, 'communityPrincipal', { subject: 'u1', roles: [] });
    await next();
  });
  app.use(
    '*',
    createAutoModMiddleware({
      autoModerationHook: hook as Parameters<
        typeof createAutoModMiddleware
      >[0]['autoModerationHook'],
      reportAdapter,
    }),
  );
  app.post('/threads', c => c.json({ ok: true }));
  return app;
}

async function postBody(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('autoMod middleware', () => {
  test('reject decision returns 403', async () => {
    const { adapter, created } = stubReportAdapter();
    const app = buildApp(() => 'reject', adapter);
    const res = await postBody(app, '/threads', { body: 'spam' });
    expect(res.status).toBe(403);
    expect(created.length).toBe(0);
  });

  test('flag decision creates a report and allows through', async () => {
    const { adapter, created } = stubReportAdapter();
    const app = buildApp(() => 'flag', adapter);
    const res = await postBody(app, '/threads', { body: 'iffy' });
    expect(res.status).toBe(200);
    expect(created.length).toBe(1);
    expect((created[0] as { reporterId: string }).reporterId).toBe('system:automod');
  });

  test('allow decision passes through', async () => {
    const { adapter, created } = stubReportAdapter();
    const app = buildApp(() => 'allow', adapter);
    const res = await postBody(app, '/threads', { body: 'ok' });
    expect(res.status).toBe(200);
    expect(created.length).toBe(0);
  });

  test('no hook configured -> passthrough', async () => {
    const { adapter } = stubReportAdapter();
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'communityPrincipal', { subject: 'u1', roles: [] });
      await next();
    });
    app.use('*', createAutoModMiddleware({ reportAdapter: adapter }));
    app.post('/threads', c => c.json({ ok: true }));
    const res = await postBody(app, '/threads', { body: 'whatever' });
    expect(res.status).toBe(200);
  });
});
