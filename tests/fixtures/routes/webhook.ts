import { webhookAuth } from '@framework/middleware/webhookAuth';
import { createRouter } from '@lastshotlabs/slingshot-core';

export const router = createRouter();

// GitHub-style: prefix "sha256=", default header, sha256 algorithm
router.post(
  '/webhook/github',
  webhookAuth({
    secret: 'test-webhook-secret',
    prefix: 'sha256=',
    algorithm: 'sha256',
  }),
  c => c.json({ ok: true }),
);

// Custom header + sha512
router.post(
  '/webhook/sha512',
  webhookAuth({
    secret: 'test-secret-512',
    header: 'x-custom-sig',
    algorithm: 'sha512',
  }),
  async c => {
    // Intentionally reads the body as JSON to verify Hono's body caching works
    const body = await c.req.json();
    return c.json({ ok: true, echo: body });
  },
);

// Timestamp replay protection
router.post(
  '/webhook/timestamped',
  webhookAuth({
    secret: 'test-timestamp-secret',
    timestamp: { header: 'x-webhook-timestamp', tolerance: 300_000 },
  }),
  c => c.json({ ok: true }),
);

// Dynamic secret resolved per-request
router.post(
  '/webhook/dynamic',
  webhookAuth({
    secret: c => {
      const tenant = c.req.header('x-tenant-id');
      if (tenant === 'acme') return 'acme-secret';
      return 'default-secret';
    },
  }),
  c => c.json({ ok: true }),
);

// Dynamic secret that always throws (tests 500 handling)
router.post(
  '/webhook/broken-secret',
  webhookAuth({
    secret: () => {
      throw new Error('secret store unavailable');
    },
  }),
  c => c.json({ ok: true }),
);
