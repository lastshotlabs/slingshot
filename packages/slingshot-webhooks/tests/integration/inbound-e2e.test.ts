import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createInboundRouter } from '../../src/routes/inbound';
import { signPayload, verifySignature } from '../../src/lib/signing';
import type { InboundProvider } from '../../src/types/inbound';

/**
 * Integration test for the end-to-end inbound webhook flow:
 *
 * 1. A third-party sender POSTs a JSON payload with a signature header.
 * 2. The inbound router receives it, verifies the signature via the provider.
 * 3. On success, emits a `webhook:inbound.<provider>` bus event.
 * 4. The bus event payload contains the provider name, parsed payload, and raw body.
 *
 * This test uses the real `signPayload`/`verifySignature` helpers to demonstrate
 * the full signing round-trip, simulating a real provider like Stripe or GitHub.
 */
describe('inbound webhook E2E — full signing round-trip', () => {
  const WEBHOOK_SECRET = 'whsec_test_secret_key_12345';

  /**
   * Simulates a third-party service (e.g. Stripe) that signs its webhook payloads.
   */
  const simulatedThirdPartyProvider: InboundProvider = {
    name: 'simulated-service',
    async verify(c, rawBody) {
      const signature = c.req.header('x-webhook-signature') ?? '';
      const valid = await verifySignature(WEBHOOK_SECRET, rawBody, signature);
      if (!valid) {
        return { verified: false, reason: 'Invalid signature' };
      }
      try {
        const payload = JSON.parse(rawBody) as unknown;
        return { verified: true, payload };
      } catch (err) {
        return {
          verified: false,
          reason: err instanceof Error ? err.message : 'Invalid JSON',
        };
      }
    },
  };

  it('receives, verifies signature, parses body, and emits bus event', async () => {
    const bus = createInProcessAdapter();
    const emitMock = mock(bus.emit.bind(bus)) as typeof bus.emit;
    bus.emit = emitMock;

    const app = new Hono();
    app.route(
      '/webhooks/inbound',
      createInboundRouter([simulatedThirdPartyProvider], bus),
    );

    const payload = { type: 'payment_intent.succeeded', id: 'pi_123', amount: 2000 };
    const bodyStr = JSON.stringify(payload);

    // Sign the payload the same way the third-party service would.
    const signature = await signPayload(WEBHOOK_SECRET, bodyStr);

    const res = await app.request('/webhooks/inbound/simulated-service', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body: bodyStr,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);

    // Verify that the bus event was emitted with the correct data.
    expect(emitMock).toHaveBeenCalledWith('webhook:inbound.simulated-service', {
      provider: 'simulated-service',
      payload,
      rawBody: bodyStr,
    });
  });

  it('rejects requests with an invalid signature', async () => {
    const bus = createInProcessAdapter();
    const app = new Hono();
    app.route(
      '/webhooks/inbound',
      createInboundRouter([simulatedThirdPartyProvider], bus),
    );

    const payload = { type: 'charge.refunded', id: 'ch_456' };
    const bodyStr = JSON.stringify(payload);

    // Use a wrong secret to sign — signature will not match.
    const badSignature = await signPayload('wrong-secret', bodyStr);

    const res = await app.request('/webhooks/inbound/simulated-service', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': badSignature,
      },
      body: bodyStr,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid signature');
  });

  it('rejects requests with a missing signature header', async () => {
    const bus = createInProcessAdapter();
    const app = new Hono();
    app.route(
      '/webhooks/inbound',
      createInboundRouter([simulatedThirdPartyProvider], bus),
    );

    const res = await app.request('/webhooks/inbound/simulated-service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ping' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects requests with a tampered body', async () => {
    const bus = createInProcessAdapter();
    const app = new Hono();
    app.route(
      '/webhooks/inbound',
      createInboundRouter([simulatedThirdPartyProvider], bus),
    );

    const originalBody = JSON.stringify({ type: 'payment_intent.succeeded', id: 'pi_789' });
    const signature = await signPayload(WEBHOOK_SECRET, originalBody);

    // Send a DIFFERENT body than what was signed.
    const tamperedBody = JSON.stringify({ type: 'payment_intent.succeeded', id: 'pi_TAMPERED' });

    const res = await app.request('/webhooks/inbound/simulated-service', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body: tamperedBody,
    });

    expect(res.status).toBe(400);
  });

  it('rate limits requests when rate limiter is configured', async () => {
    const bus = createInProcessAdapter();
    const app = new Hono();
    app.route(
      '/webhooks/inbound',
      createInboundRouter([simulatedThirdPartyProvider], bus, {
        rateLimiter: { maxRequests: 2, windowMs: 60_000 },
      }),
    );

    const payload = { type: 'ping' };
    const bodyStr = JSON.stringify(payload);
    const signature = await signPayload(WEBHOOK_SECRET, bodyStr);
    const headers = {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': signature,
    };

    // First two requests should succeed.
    const res1 = await app.request('/webhooks/inbound/simulated-service', {
      method: 'POST',
      headers,
      body: bodyStr,
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/webhooks/inbound/simulated-service', {
      method: 'POST',
      headers,
      body: bodyStr,
    });
    expect(res2.status).toBe(200);

    // Third request should be rate-limited (429).
    const res3 = await app.request('/webhooks/inbound/simulated-service', {
      method: 'POST',
      headers,
      body: bodyStr,
    });
    expect(res3.status).toBe(429);
    const body = (await res3.json()) as { error: string };
    expect(body.error).toBe('Too Many Requests');
    expect(res3.headers.get('Retry-After')).not.toBeNull();
    expect(res3.headers.get('X-RateLimit-Limit')).not.toBeNull();
  });
});
