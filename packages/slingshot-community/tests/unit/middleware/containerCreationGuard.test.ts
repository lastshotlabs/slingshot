import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { PermissionEvaluator } from '@lastshotlabs/slingshot-core';
import { createContainerCreationGuardMiddleware } from '../../../src/middleware/containerCreationGuard';
import { setVar } from './_helpers';

function stubEvaluator(allow: boolean): PermissionEvaluator {
  return {
    async can() {
      return allow;
    },
  };
}

describe('containerCreationGuard middleware', () => {
  test('user mode: anyone authenticated can create', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'communityPrincipal', { subject: 'u1', roles: [] });
      await next();
    });
    app.use(
      '*',
      createContainerCreationGuardMiddleware({
        containerCreation: 'user',
        permissionEvaluator: stubEvaluator(false),
      }),
    );
    app.post('/containers', c => c.json({ ok: true }));

    const res = await app.request('/containers', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('admin mode: unauthorized without principal', async () => {
    const app = new Hono();
    app.use(
      '*',
      createContainerCreationGuardMiddleware({
        containerCreation: 'admin',
        permissionEvaluator: stubEvaluator(true),
      }),
    );
    app.post('/containers', c => c.json({ ok: true }));

    const res = await app.request('/containers', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('admin mode: forbidden when evaluator denies', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'communityPrincipal', { subject: 'u1', roles: [] });
      await next();
    });
    app.use(
      '*',
      createContainerCreationGuardMiddleware({
        containerCreation: 'admin',
        permissionEvaluator: stubEvaluator(false),
      }),
    );
    app.post('/containers', c => c.json({ ok: true }));

    const res = await app.request('/containers', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  test('admin mode: allowed when evaluator permits', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'communityPrincipal', { subject: 'u1', roles: ['admin'] });
      await next();
    });
    app.use(
      '*',
      createContainerCreationGuardMiddleware({
        containerCreation: 'admin',
        permissionEvaluator: stubEvaluator(true),
      }),
    );
    app.post('/containers', c => c.json({ ok: true }));

    const res = await app.request('/containers', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
