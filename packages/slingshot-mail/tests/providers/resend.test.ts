import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createResendProvider } from '../../src/providers/resend.js';
import { MailSendError } from '../../src/types/provider.js';

describe('createResendProvider', () => {
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
    const responseData = { id: 'msg-abc-123' };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => responseData,
    });

    const provider = createResendProvider({ apiKey: 'test-key' });
    const result = await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
    });

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('msg-abc-123');

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string);
    expect(body.from).toBe('sender@example.com');
    expect(body.to).toBe('recipient@example.com');
    expect(body.subject).toBe('Hello');
    expect(body.html).toBe('<p>Hello</p>');
  });

  it('formats address objects correctly', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-1' }),
    });

    const provider = createResendProvider({ apiKey: 'test-key' });
    await provider.send({
      from: { name: 'Sender', email: 'sender@example.com' },
      to: [{ name: 'Recip', email: 'recip@example.com' }, 'other@example.com'],
      subject: 'Test',
      html: '<p>Test</p>',
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.from).toBe('Sender <sender@example.com>');
    expect(body.to).toEqual(['Recip <recip@example.com>', 'other@example.com']);
  });

  it('throws retryable MailSendError on 429', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    });

    const provider = createResendProvider({ apiKey: 'test-key' });
    const err = await provider
      .send({
        to: 'r@example.com',
        subject: 'X',
        html: '<p>X</p>',
      })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).statusCode).toBe(429);
  });

  it('throws retryable MailSendError on 500', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const provider = createResendProvider({ apiKey: 'test-key' });
    const err = await provider
      .send({
        to: 'r@example.com',
        subject: 'X',
        html: '<p>X</p>',
      })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).statusCode).toBe(500);
  });

  it('throws non-retryable MailSendError on 422', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'Unprocessable Entity',
    });

    const provider = createResendProvider({ apiKey: 'test-key' });
    const err = await provider
      .send({
        to: 'r@example.com',
        subject: 'X',
        html: '<p>X</p>',
      })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(false);
    expect((err as MailSendError).statusCode).toBe(422);
  });

  it('uses a custom baseUrl when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-2' }),
    });

    const provider = createResendProvider({
      apiKey: 'key',
      baseUrl: 'https://custom.resend.local',
    });
    await provider.send({ to: 'r@example.com', subject: 'X', html: '<p>X</p>' });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://custom.resend.local/emails');
  });

  it('includes tags and reply_to when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-3' }),
    });

    const provider = createResendProvider({ apiKey: 'key' });
    await provider.send({
      to: 'r@example.com',
      subject: 'X',
      html: '<p>X</p>',
      replyTo: 'reply@example.com',
      tags: { campaign: 'welcome', type: 'transactional' },
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.reply_to).toBe('reply@example.com');
    expect(body.tags).toEqual([
      { name: 'campaign', value: 'welcome' },
      { name: 'type', value: 'transactional' },
    ]);
  });
});
