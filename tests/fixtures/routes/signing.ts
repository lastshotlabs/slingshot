import { Hono } from 'hono';
import { idempotent } from '../../../src/framework/lib/idempotency';
import { requireSignedRequest } from '../../../src/framework/middleware/requestSigning';
import { createPresignedUrl, verifyPresignedUrl } from '../../../src/lib/signing';

const SECRET = 'fixture-secret-32-chars-long-xxxxx';

const app = new Hono();

// Route protected by idempotency
app.use('/orders', idempotent({ ttl: 3600 }));
app.post('/orders', async c => {
  return c.json({ orderId: crypto.randomUUID() }, 201);
});

// Route protected by request signing
app.use('/signed/*', requireSignedRequest({ tolerance: 30_000 }));
app.post('/signed/data', async c => {
  const body = await c.req.json();
  return c.json({ received: body });
});

// Presigned URL generation
app.get('/presign/:key{.+}', async c => {
  const { key } = c.req.param();
  const url = createPresignedUrl(
    'https://api.example.com/download',
    key,
    { method: 'GET', expiry: 3600 },
    SECRET,
  );
  return c.json({ url });
});

// Presigned URL consumption
app.get('/download/:key{.+}', async c => {
  const requestUrl = c.req.url;
  const result = verifyPresignedUrl(requestUrl, 'GET', SECRET);
  if (!result) return c.json({ error: 'Invalid or expired URL' }, 403);
  return c.json({ key: result.key });
});

export default app;
