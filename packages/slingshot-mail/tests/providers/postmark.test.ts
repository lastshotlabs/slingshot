import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createPostmarkProvider } from '../../src/providers/postmark.js';
import { MailSendError } from '../../src/types/provider.js';

describe('createPostmarkProvider', () => {
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

  it('sends a message and returns sent status on 200', async () => {
    const responseData = { MessageID: 'pm-msg-123' };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => responseData,
    });

    const provider = createPostmarkProvider({ serverToken: 'test-token' });
    const result = await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello Postmark',
      html: '<p>Hello</p>',
      text: 'Hello',
    });

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('pm-msg-123');

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string);
    expect(body.From).toBe('sender@example.com');
    expect(body.To).toBe('recipient@example.com');
    expect(body.Subject).toBe('Hello Postmark');
    expect(body.HtmlBody).toBe('<p>Hello</p>');
    expect(body.TextBody).toBe('Hello');
  });

  it('joins multiple recipients with comma', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ MessageID: 'pm-2' }),
    });

    const provider = createPostmarkProvider({ serverToken: 'token' });
    await provider.send({
      to: [{ name: 'Alice', email: 'alice@example.com' }, 'bob@example.com'],
      subject: 'Multi',
      html: '<p>Multi</p>',
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.To).toBe('Alice <alice@example.com>, bob@example.com');
  });

  it('throws retryable MailSendError on 429', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });

    const provider = createPostmarkProvider({ serverToken: 'token' });
    const err = await provider
      .send({ to: 'r@e.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).statusCode).toBe(429);
  });

  it('throws retryable MailSendError on 500', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const provider = createPostmarkProvider({ serverToken: 'token' });
    const err = await provider
      .send({ to: 'r@e.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
  });

  it('throws non-retryable MailSendError on 422', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'bad data',
    });

    const provider = createPostmarkProvider({ serverToken: 'token' });
    const err = await provider
      .send({ to: 'r@e.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(false);
  });

  it('includes headers when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ MessageID: 'pm-3' }),
    });

    const provider = createPostmarkProvider({ serverToken: 'token' });
    await provider.send({
      to: 'r@e.com',
      subject: 'X',
      html: '<p>X</p>',
      headers: { 'X-Custom': 'value' },
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.Headers).toEqual([{ Name: 'X-Custom', Value: 'value' }]);
  });
});
