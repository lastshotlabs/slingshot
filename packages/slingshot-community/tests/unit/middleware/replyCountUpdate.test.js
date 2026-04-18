import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createReplyCountUpdateMiddleware } from '../../../src/middleware/replyCountUpdate';

function buildSpy() {
  const calls = [];
  return {
    calls,
    async incrementReplyCount(id) {
      calls.push({ method: 'incrementReplyCount', id });
    },
    async updateLastActivity(match, data) {
      calls.push({ method: 'updateLastActivity', id: match.id, data });
    },
  };
}
function buildApp(spy, responseBody, status = 201) {
  const app = new Hono();
  app.use('*', createReplyCountUpdateMiddleware({ threadAdapter: spy }));
  app.post('/replies', c => c.json(responseBody, status));
  return app;
}
describe('replyCountUpdate middleware', () => {
  test('increments replyCount on successful reply creation', async () => {
    const spy = buildSpy();
    const app = buildApp(spy, {
      threadId: 't1',
      authorId: 'u1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    await app.request('/replies', { method: 'POST' });
    expect(spy.calls.some(c => c.method === 'incrementReplyCount' && c.id === 't1')).toBe(true);
  });
  test('updates lastActivity on successful reply creation', async () => {
    const spy = buildSpy();
    const app = buildApp(spy, {
      threadId: 't1',
      authorId: 'user-42',
      createdAt: '2024-06-15T12:00:00.000Z',
    });
    await app.request('/replies', { method: 'POST' });
    const call = spy.calls.find(c => c.method === 'updateLastActivity' && c.id === 't1');
    expect(call).toBeDefined();
    const data = call.data;
    expect(data.lastReplyById).toBe('user-42');
    expect(data.lastReplyAt).toBe('2024-06-15T12:00:00.000Z');
  });
  test('no-ops when response has no threadId', async () => {
    const spy = buildSpy();
    const app = buildApp(spy, { id: 'r1' /* no threadId */ });
    await app.request('/replies', { method: 'POST' });
    expect(spy.calls).toHaveLength(0);
  });
  test('no-ops when response status is 4xx', async () => {
    const spy = buildSpy();
    const app = buildApp(spy, { error: 'bad input', threadId: 't1' }, 400);
    await app.request('/replies', { method: 'POST' });
    expect(spy.calls).toHaveLength(0);
  });
  test('no-ops when response status is 5xx', async () => {
    const spy = buildSpy();
    const app = buildApp(spy, { error: 'server error', threadId: 't1' }, 500);
    await app.request('/replies', { method: 'POST' });
    expect(spy.calls).toHaveLength(0);
  });
  test('uses current time when createdAt is absent from response', async () => {
    const spy = buildSpy();
    const before = Date.now();
    const app = buildApp(spy, { threadId: 't1', authorId: 'u1' /* no createdAt */ });
    await app.request('/replies', { method: 'POST' });
    const call = spy.calls.find(c => c.method === 'updateLastActivity');
    expect(call).toBeDefined();
    const data = call.data;
    const ts = new Date(data.lastActivityAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
  });
});
