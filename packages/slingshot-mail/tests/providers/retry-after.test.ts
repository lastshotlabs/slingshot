/**
 * Cross-provider coverage for `Retry-After` header propagation on 429/5xx
 * responses. Each fetch-based provider should surface the parsed delay on
 * `MailSendError.retryAfterMs` so queue workers can honour upstream backoff
 * hints. Mirrors the pattern used by the web push provider.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createPostmarkProvider } from '../../src/providers/postmark.js';
import { createResendProvider } from '../../src/providers/resend.js';
import { createSendgridProvider } from '../../src/providers/sendgrid.js';
import { MailSendError } from '../../src/types/provider.js';

const TEST_MESSAGE = {
  to: 'r@example.com',
  subject: 'X',
  html: '<p>X</p>',
};

interface FetchResponseFixture {
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function failingResponse(status: number, retryAfter: string | null): FetchResponseFixture {
  const headers = new Headers();
  if (retryAfter !== null) headers.set('Retry-After', retryAfter);
  return {
    ok: false,
    status,
    headers,
    text: async () => 'fail',
    json: async () => ({}),
  };
}

describe('mail providers — Retry-After propagation', () => {
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

  it('Resend 429 with Retry-After: 5 → MailSendError.retryAfterMs = 5000', async () => {
    mockFetch.mockResolvedValue(failingResponse(429, '5'));
    const err = await createResendProvider({ apiKey: 'k' })
      .send(TEST_MESSAGE)
      .catch(e => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).statusCode).toBe(429);
    expect((err as MailSendError).retryAfterMs).toBe(5000);
  });

  it('Resend 503 with no Retry-After → retryAfterMs undefined', async () => {
    mockFetch.mockResolvedValue(failingResponse(503, null));
    const err = await createResendProvider({ apiKey: 'k' })
      .send(TEST_MESSAGE)
      .catch(e => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).statusCode).toBe(503);
    expect((err as MailSendError).retryAfterMs).toBeUndefined();
  });

  it('SendGrid 429 with Retry-After: 12 → retryAfterMs = 12000', async () => {
    mockFetch.mockResolvedValue(failingResponse(429, '12'));
    const err = await createSendgridProvider({ apiKey: 'k' })
      .send(TEST_MESSAGE)
      .catch(e => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).retryAfterMs).toBe(12_000);
  });

  it('SendGrid 502 with HTTP-date Retry-After → retryAfterMs is positive', async () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    mockFetch.mockResolvedValue(failingResponse(502, future));
    const err = await createSendgridProvider({ apiKey: 'k' })
      .send(TEST_MESSAGE)
      .catch(e => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryAfterMs).toBeGreaterThan(0);
  });

  it('Postmark 429 with Retry-After: 7 → retryAfterMs = 7000', async () => {
    mockFetch.mockResolvedValue(failingResponse(429, '7'));
    const err = await createPostmarkProvider({ serverToken: 't' })
      .send(TEST_MESSAGE)
      .catch(e => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).retryAfterMs).toBe(7000);
  });

  it('Postmark 500 → retryable but retryAfterMs undefined when header missing', async () => {
    mockFetch.mockResolvedValue(failingResponse(500, null));
    const err = await createPostmarkProvider({ serverToken: 't' })
      .send(TEST_MESSAGE)
      .catch(e => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).retryAfterMs).toBeUndefined();
  });

  it('Resend 422 (non-retryable) still surfaces Retry-After when provider sends one', async () => {
    // Some providers attach Retry-After even on non-retryable replies.
    // The error contract: retryable reflects the status, retryAfterMs reflects
    // the header verbatim — they are independent signals.
    mockFetch.mockResolvedValue(failingResponse(422, '10'));
    const err = await createResendProvider({ apiKey: 'k' })
      .send(TEST_MESSAGE)
      .catch(e => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(false);
    expect((err as MailSendError).retryAfterMs).toBe(10_000);
  });
});
