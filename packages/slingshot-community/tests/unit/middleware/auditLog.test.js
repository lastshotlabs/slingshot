import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createAuditLogMiddleware } from '../../../src/middleware/auditLog';
import { setVar } from './_helpers';

function stubGate() {
  const entries = [];
  const gate = {
    async verifyRequest() {
      return null;
    },
    async logAuditEntry(entry) {
      entries.push(entry);
    },
  };
  return { gate, entries };
}
describe('auditLog middleware', () => {
  test('logs on 2xx response', async () => {
    const { gate, entries } = stubGate();
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'communityPrincipal', { subject: 'u1', roles: ['admin'] });
      await next();
    });
    app.use('*', createAuditLogMiddleware({ adminGate: gate }));
    app.delete('/reports/:reportId', c => c.json({ ok: true }));
    const res = await app.request('/reports/r1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(entries.length).toBe(1);
    expect(entries[0]?.actorId).toBe('u1');
    expect(entries[0]?.resource).toBe('community');
  });
  test('skips logging on non-2xx', async () => {
    const { gate, entries } = stubGate();
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'communityPrincipal', { subject: 'u1', roles: ['admin'] });
      await next();
    });
    app.use('*', createAuditLogMiddleware({ adminGate: gate }));
    app.delete('/reports/:reportId', c => c.json({ error: 'nope' }, 400));
    const res = await app.request('/reports/r1', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(entries.length).toBe(0);
  });
  test('noop when adminGate not configured', async () => {
    const app = new Hono();
    app.use('*', createAuditLogMiddleware({}));
    app.get('/x', c => c.json({ ok: true }));
    const res = await app.request('/x');
    expect(res.status).toBe(200);
  });
});
