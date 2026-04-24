import { requireRole } from '@auth/middleware/requireRole';
import { requireVerifiedEmail } from '@auth/middleware/requireVerifiedEmail';
import { userAuth } from '@auth/middleware/userAuth';
import { cacheResponse } from '@framework/middleware/cacheResponse';
import { createRouter, getActor } from '@lastshotlabs/slingshot-core';

export const router = createRouter();

router.get('/protected/admin', userAuth, requireRole('admin'), c => {
  return c.json({ message: 'admin only' });
});

router.get('/protected/multi-role', userAuth, requireRole('admin', 'moderator'), c => {
  return c.json({ message: 'multi-role access' });
});

router.get('/protected/global-role', userAuth, requireRole.global('admin'), c => {
  return c.json({ message: 'global admin' });
});

router.get(
  '/protected/tenant-admin',
  async (c, next) => {
    const tenantId = c.req.header('x-tenant-id') ?? null;
    if (tenantId) c.set('tenantId', tenantId);
    await next();
  },
  userAuth,
  requireRole('admin'),
  c => {
    return c.json({ message: 'tenant admin' });
  },
);

router.get('/cached', cacheResponse({ key: 'test-cached', ttl: 60, store: 'memory' }), c => {
  return c.json({ time: Date.now() });
});

router.get(
  '/cached-dynamic',
  cacheResponse({ key: c => 'dyn:' + (c.req.query('k') ?? 'default'), ttl: 60, store: 'memory' }),
  c => {
    return c.json({ time: Date.now(), key: c.req.query('k') });
  },
);

router.get('/cached-default', cacheResponse({ key: 'test-cached-default', ttl: 60 }), c => {
  return c.json({ time: Date.now() });
});

router.post('/protected/action', userAuth, c => {
  return c.json({ message: 'action performed' });
});

router.post('/public/action', c => {
  return c.json({ message: 'public action performed' });
});

// Exposes identify context without requiring auth — used by identify.test.ts
router.get('/me-raw', c => {
  const actor = getActor(c);
  return c.json({
    actorId: actor.kind === 'anonymous' ? null : actor.id,
    sessionId: actor.sessionId,
  });
});

// Requires email verification — used by requireVerifiedEmail.test.ts
router.get('/protected/verified', userAuth, requireVerifiedEmail, c => {
  return c.json({ ok: true });
});

// requireRole WITHOUT userAuth — tests the 401 branch in requireRole itself
router.get('/protected/role-no-auth', requireRole('admin'), c => {
  return c.json({ message: 'role-no-auth' });
});

// requireRole.global WITHOUT userAuth — tests the 401 branch in requireRole.global
router.get('/protected/global-role-no-auth', requireRole.global('admin'), c => {
  return c.json({ message: 'global-role-no-auth' });
});

// requireVerifiedEmail WITHOUT userAuth — tests the 401 branch in requireVerifiedEmail
router.get('/protected/verified-no-auth', requireVerifiedEmail, c => {
  return c.json({ ok: true });
});

// Throws an error — used by requestLogger tests
router.get('/protected/throw-error', () => {
  throw new Error('Test handler error');
});
