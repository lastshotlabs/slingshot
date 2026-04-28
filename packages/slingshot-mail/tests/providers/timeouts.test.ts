import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createPostmarkProvider } from '../../src/providers/postmark.js';
import { createResendProvider } from '../../src/providers/resend.js';
import { createSendgridProvider } from '../../src/providers/sendgrid.js';
import { MailSendError } from '../../src/types/provider.js';

/**
 * P-MAIL-5 / P-MAIL-6: every fetch-based provider must abort hung requests
 * with the configured `providerTimeoutMs` deadline and surface a retryable
 * MailSendError. We exercise each provider against a fetch that never
 * resolves and assert the timeout fires.
 */
describe('mail provider timeouts (P-MAIL-5 / P-MAIL-6)', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Hang forever unless aborted, then reject with a DOMException so the
    // provider's catch arm sees the abort path.
    mockFetch = mock(async (_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it('Resend aborts hung fetch and throws retryable timeout', async () => {
    const provider = createResendProvider({ apiKey: 'k', providerTimeoutMs: 25 });
    const err = await provider
      .send({ to: 'r@example.com', subject: 'X', html: '<p/>' })
      .catch(e => e as Error);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as Error).message).toMatch(/timed out/i);
  });

  it('Postmark aborts hung fetch and throws retryable timeout', async () => {
    const provider = createPostmarkProvider({ serverToken: 't', providerTimeoutMs: 25 });
    const err = await provider
      .send({ to: 'r@example.com', subject: 'X', html: '<p/>' })
      .catch(e => e as Error);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as Error).message).toMatch(/timed out/i);
  });

  it('SendGrid aborts hung fetch and throws retryable timeout', async () => {
    const provider = createSendgridProvider({ apiKey: 'k', providerTimeoutMs: 25 });
    const err = await provider
      .send({ to: 'r@example.com', subject: 'X', html: '<p/>' })
      .catch(e => e as Error);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as Error).message).toMatch(/timed out/i);
  });
});
