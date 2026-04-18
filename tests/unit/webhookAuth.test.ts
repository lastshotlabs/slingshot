import { beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { createTestApp } from '../setup';

function sign(secret: string, body: string, algorithm = 'sha256'): string {
  return createHmac(algorithm, secret).update(body).digest('hex');
}

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeEach(async () => {
  app = await createTestApp();
});

// ---------------------------------------------------------------------------
// GitHub-style (sha256=<hex>, default header)
// ---------------------------------------------------------------------------

describe('webhookAuth — GitHub style (sha256 prefix)', () => {
  const secret = 'test-webhook-secret';
  const body = JSON.stringify({ action: 'push' });

  test('valid signature passes', async () => {
    const sig = 'sha256=' + sign(secret, body);
    const res = await app.request('/webhook/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sig },
      body,
    });
    expect(res.status).toBe(200);
  });

  test('invalid signature → 401 INVALID_SIGNATURE', async () => {
    const res = await app.request('/webhook/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': 'sha256=deadbeef' },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_SIGNATURE');
  });

  test('missing signature header → 401 INVALID_SIGNATURE', async () => {
    const res = await app.request('/webhook/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_SIGNATURE');
  });

  test('sig without prefix passes (prefix is stripped when present, not required)', async () => {
    // When the header doesn't start with the configured prefix, the full value is used as-is.
    // A raw hex digest is still valid because the HMAC comparison is hex-to-hex.
    const sig = sign(secret, body); // raw hex, no "sha256=" prefix
    const res = await app.request('/webhook/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sig },
      body,
    });
    expect(res.status).toBe(200);
  });

  test('malformed sig with multi-byte Unicode (same char length, different byte length) → 401', async () => {
    // "é" is 2 bytes in UTF-8 — craft a string that has the same character length as a sha256 hex
    // digest (64 chars) but different byte count.
    const validHex = sign(secret, body);
    // Replace first char with a 2-byte Unicode char to keep length=64 chars but change byte size
    const malformed = 'é' + validHex.slice(1);
    expect(malformed.length).toBe(64); // same char length
    const res = await app.request('/webhook/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': 'sha256=' + malformed },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_SIGNATURE');
  });
});

// ---------------------------------------------------------------------------
// sha512 + custom header
// ---------------------------------------------------------------------------

describe('webhookAuth — sha512 + custom header', () => {
  const secret = 'test-secret-512';
  const body = JSON.stringify({ data: 42 });

  test('valid sha512 sig in custom header passes', async () => {
    const sig = sign(secret, body, 'sha512');
    expect(sig).toHaveLength(128); // sha512 = 128 hex chars
    const res = await app.request('/webhook/sha512', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-custom-sig': sig },
      body,
    });
    expect(res.status).toBe(200);
  });

  test('body is still readable as JSON by route handler (Hono body caching)', async () => {
    const sig = sign(secret, body, 'sha512');
    const res = await app.request('/webhook/sha512', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-custom-sig': sig },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; echo: { data: number } };
    expect(json.ok).toBe(true);
    expect(json.echo.data).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Timestamp replay protection
// ---------------------------------------------------------------------------

describe('webhookAuth — timestamp replay protection', () => {
  const secret = 'test-timestamp-secret';
  const body = '{}';

  test('valid timestamp (within tolerance) passes', async () => {
    const ts = Math.floor(Date.now() / 1000).toString(); // Unix seconds
    const sig = sign(secret, body);
    const res = await app.request('/webhook/timestamped', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': sig,
        'x-webhook-timestamp': ts,
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  test('expired timestamp (outside tolerance) → 401 EXPIRED_TIMESTAMP', async () => {
    const ts = Math.floor((Date.now() - 10 * 60 * 1000) / 1000).toString(); // 10 min ago
    const sig = sign(secret, body);
    const res = await app.request('/webhook/timestamped', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': sig,
        'x-webhook-timestamp': ts,
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('EXPIRED_TIMESTAMP');
  });

  test('missing timestamp header → 401 EXPIRED_TIMESTAMP', async () => {
    const sig = sign(secret, body);
    const res = await app.request('/webhook/timestamped', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sig },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('EXPIRED_TIMESTAMP');
  });

  test('non-numeric timestamp header → 401 EXPIRED_TIMESTAMP', async () => {
    const sig = sign(secret, body);
    const res = await app.request('/webhook/timestamped', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': sig,
        'x-webhook-timestamp': 'not-a-number',
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('EXPIRED_TIMESTAMP');
  });
});

// ---------------------------------------------------------------------------
// Dynamic secret
// ---------------------------------------------------------------------------

describe('webhookAuth — dynamic secret', () => {
  const body = '{}';

  test('resolves correct secret for acme tenant', async () => {
    const sig = sign('acme-secret', body);
    const res = await app.request('/webhook/dynamic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': sig,
        'x-tenant-id': 'acme',
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  test('resolves default secret for unknown tenant', async () => {
    const sig = sign('default-secret', body);
    const res = await app.request('/webhook/dynamic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': sig,
        'x-tenant-id': 'unknown',
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  test('wrong secret for tenant → 401', async () => {
    const sig = sign('acme-secret', body);
    const res = await app.request('/webhook/dynamic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': sig,
        'x-tenant-id': 'unknown', // expects default-secret
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  test('dynamic secret function throws → 500 WEBHOOK_SECRET_ERROR', async () => {
    const res = await app.request('/webhook/broken-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': 'whatever' },
      body,
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('WEBHOOK_SECRET_ERROR');
  });
});
