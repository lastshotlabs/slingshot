/**
 * Provider-level circuit breaker integration. Confirms each fetch-based
 * provider fails fast with `MailCircuitOpenError` after the configured
 * consecutive-failure threshold trips, and recovers when the cooldown elapses.
 *
 * The breaker state machine is exercised in tests/lib/retry-circuit.test.ts;
 * this file covers wiring through the provider factories so a regression in
 * one of them surfaces here.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MailCircuitOpenError } from '../../src/lib/circuitBreaker.js';
import { createPostmarkProvider } from '../../src/providers/postmark.js';
import { createResendProvider } from '../../src/providers/resend.js';
import { createSendgridProvider } from '../../src/providers/sendgrid.js';

const MSG = { to: 'r@example.com', subject: 'X', html: '<p>X</p>' };

function makeFailing500(): Response {
  return new Response('boom', { status: 500 });
}

describe('provider circuit breaker', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = mock(() => Promise.resolve());
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it('Resend: opens after threshold consecutive failures and rejects subsequent calls', async () => {
    mockFetch.mockResolvedValue(makeFailing500());
    let now = 0;
    const provider = createResendProvider({
      apiKey: 'k',
      circuitBreaker: { threshold: 2, cooldownMs: 1_000, now: () => now },
    });

    await provider.send(MSG).catch(() => {});
    await provider.send(MSG).catch(() => {});

    // Breaker is now open — next call should fail fast WITHOUT hitting fetch.
    const callsBefore = mockFetch.mock.calls.length;
    const err = await provider.send(MSG).catch(e => e);
    expect(err).toBeInstanceOf(MailCircuitOpenError);
    expect((err as MailCircuitOpenError).providerName).toBe('resend');
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it('Resend: half-open probe succeeds and closes the breaker again', async () => {
    let now = 0;
    const provider = createResendProvider({
      apiKey: 'k',
      circuitBreaker: { threshold: 1, cooldownMs: 100, now: () => now },
    });

    mockFetch.mockResolvedValueOnce(makeFailing500());
    await provider.send(MSG).catch(() => {});

    // Advance past cooldown — half-open probe is admitted.
    now = 200;
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await provider.send(MSG);
    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('ok');
  });

  it('SendGrid: trips on consecutive 502s', async () => {
    mockFetch.mockResolvedValue(new Response('bad gateway', { status: 502 }));
    let now = 0;
    const provider = createSendgridProvider({
      apiKey: 'k',
      circuitBreaker: { threshold: 3, cooldownMs: 5_000, now: () => now },
    });

    await provider.send(MSG).catch(() => {});
    await provider.send(MSG).catch(() => {});
    await provider.send(MSG).catch(() => {});

    const err = await provider.send(MSG).catch(e => e);
    expect(err).toBeInstanceOf(MailCircuitOpenError);
    expect((err as MailCircuitOpenError).providerName).toBe('sendgrid');
    expect((err as MailCircuitOpenError).retryAfterMs).toBe(5_000);
  });

  it('Postmark: success resets the consecutive-failure counter', async () => {
    let now = 0;
    const provider = createPostmarkProvider({
      serverToken: 't',
      circuitBreaker: { threshold: 3, cooldownMs: 1_000, now: () => now },
    });

    mockFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await provider.send(MSG).catch(() => {});

    mockFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await provider.send(MSG).catch(() => {});

    // Successful send — should reset the counter back to 0.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ MessageID: 'pm-ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const ok = await provider.send(MSG);
    expect(ok.messageId).toBe('pm-ok');

    // Now two more failures should still NOT trip the breaker (threshold is 3,
    // counter was reset by the success above).
    mockFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    await provider.send(MSG).catch(() => {});
    await provider.send(MSG).catch(() => {});
    const err = await provider.send(MSG).catch(e => e);
    // Third post-reset failure trips the breaker.
    expect(err).not.toBeInstanceOf(MailCircuitOpenError);

    // Subsequent call should now be circuit-rejected.
    const blocked = await provider.send(MSG).catch(e => e);
    expect(blocked).toBeInstanceOf(MailCircuitOpenError);
  });
});
