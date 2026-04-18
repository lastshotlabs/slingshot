import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createBanCheckMiddleware } from '../../../src/middleware/banCheck';
import { setVar } from './_helpers';

function matchesFilter(ban, filter) {
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$or') {
      const branches = val;
      if (!branches.some(branch => matchesFilter(ban, branch))) return false;
      continue;
    }
    const field = ban[key];
    if (val === null) {
      if (field != null) return false;
    } else if (typeof val === 'object' && val !== null) {
      const op = val;
      if ('$gt' in op) {
        const cmp = op.$gt === 'now' ? new Date().toISOString() : String(op.$gt);
        if (!field || String(field) <= cmp) return false;
      }
    } else {
      if (field !== val) return false;
    }
  }
  return true;
}
function stubAdapter(bans) {
  return {
    list: async ({ filter } = {}) => {
      const items = filter ? bans.filter(b => matchesFilter(b, filter)) : bans;
      return { items: items, total: items.length };
    },
  };
}
function buildApp(banAdapter, principal) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (principal) setVar(c, 'communityPrincipal', principal);
    await next();
  });
  app.use('/containers/:containerId/*', createBanCheckMiddleware({ banAdapter }));
  app.post('/containers/:containerId/threads', c => c.json({ ok: true }));
  return app;
}
describe('banCheck middleware', () => {
  test('blocks banned user with 403', async () => {
    const app = buildApp(stubAdapter([{ userId: 'u1', containerId: 'c1' }]), {
      subject: 'u1',
      roles: [],
    });
    const res = await app.request('/containers/c1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hi' }),
    });
    expect(res.status).toBe(403);
  });
  test('allows non-banned user', async () => {
    const app = buildApp(stubAdapter([]), { subject: 'u1', roles: [] });
    const res = await app.request('/containers/c1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hi' }),
    });
    expect(res.status).toBe(200);
  });
  test('passes through when no principal (public route)', async () => {
    const app = buildApp(stubAdapter([{ userId: 'u1', containerId: 'c1' }]));
    const res = await app.request('/containers/c1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hi' }),
    });
    expect(res.status).toBe(200);
  });
  test('allows user whose ban has expired', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const app = buildApp(stubAdapter([{ userId: 'u1', containerId: 'c1', expiresAt: pastDate }]), {
      subject: 'u1',
      roles: [],
    });
    const res = await app.request('/containers/c1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hi' }),
    });
    expect(res.status).toBe(200);
  });
  test('blocks user whose ban has not expired', async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const app = buildApp(
      stubAdapter([{ userId: 'u1', containerId: 'c1', expiresAt: futureDate }]),
      { subject: 'u1', roles: [] },
    );
    const res = await app.request('/containers/c1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hi' }),
    });
    expect(res.status).toBe(403);
  });
  test('allows user whose ban has been lifted (unbannedAt set)', async () => {
    const app = buildApp(
      stubAdapter([
        {
          userId: 'u1',
          containerId: 'c1',
          unbannedAt: new Date().toISOString(),
          unbannedBy: 'mod-1',
        },
      ]),
      { subject: 'u1', roles: [] },
    );
    const res = await app.request('/containers/c1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hi' }),
    });
    expect(res.status).toBe(200);
  });
  test('passes through when no containerId is resolvable', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'communityPrincipal', { subject: 'u1', roles: [] });
      await next();
    });
    app.use(
      '*',
      createBanCheckMiddleware({
        banAdapter: stubAdapter([{ userId: 'u1', containerId: 'c1' }]),
      }),
    );
    app.get('/noop', c => c.json({ ok: true }));
    const res = await app.request('/noop');
    expect(res.status).toBe(200);
  });
});
