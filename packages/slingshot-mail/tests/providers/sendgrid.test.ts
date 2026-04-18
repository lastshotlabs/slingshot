import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createSendgridProvider } from '../../src/providers/sendgrid.js';
import { MailSendError } from '../../src/types/provider.js';

describe('createSendgridProvider', () => {
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

  it('sends a message and returns sent status on 202', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: (h: string) => (h === 'x-message-id' ? 'sg-msg-456' : null) },
    });

    const provider = createSendgridProvider({ apiKey: 'sg-key' });
    const result = await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello SendGrid',
      html: '<p>Hello</p>',
    });

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('sg-msg-456');

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    const body = JSON.parse(options.body as string);
    expect(body.personalizations[0].to).toEqual([{ email: 'recipient@example.com' }]);
    expect(body.from).toEqual({ email: 'sender@example.com' });
    expect(body.subject).toBe('Hello SendGrid');
    expect(body.content[0]).toEqual({ type: 'text/html', value: '<p>Hello</p>' });
  });

  it('includes text/plain content when text provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: () => null },
    });

    const provider = createSendgridProvider({ apiKey: 'key' });
    await provider.send({
      to: 'r@e.com',
      subject: 'X',
      html: '<p>X</p>',
      text: 'X plain',
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.content).toHaveLength(2);
    expect(body.content[1]).toEqual({ type: 'text/plain', value: 'X plain' });
  });

  it('handles named address objects', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: () => null },
    });

    const provider = createSendgridProvider({ apiKey: 'key' });
    await provider.send({
      from: { name: 'Sender', email: 'sender@example.com' },
      to: [{ name: 'Alice', email: 'alice@example.com' }],
      subject: 'X',
      html: '<p>X</p>',
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.from).toEqual({ email: 'sender@example.com', name: 'Sender' });
    expect(body.personalizations[0].to).toEqual([{ email: 'alice@example.com', name: 'Alice' }]);
  });

  it('throws retryable MailSendError on 429', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });

    const provider = createSendgridProvider({ apiKey: 'key' });
    const err = await provider
      .send({ to: 'r@e.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
  });

  it('throws retryable MailSendError on 500', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const provider = createSendgridProvider({ apiKey: 'key' });
    const err = await provider
      .send({ to: 'r@e.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
  });

  it('throws non-retryable MailSendError on 400', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    });

    const provider = createSendgridProvider({ apiKey: 'key' });
    const err = await provider
      .send({ to: 'r@e.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(false);
    expect((err as MailSendError).statusCode).toBe(400);
  });
});
