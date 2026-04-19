import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createSesProvider } from '../../src/providers/ses.js';
import { MailSendError } from '../../src/types/provider.js';

// ---------------------------------------------------------------------------
// SES SDK mock setup — placed BEFORE importing the provider.
// Bun evaluates mock.module() at call time so it must come first.
// ---------------------------------------------------------------------------

// Track the latest instance created by new SESv2Client() so tests can control it.
const latestClientSend: ReturnType<typeof mock> = mock(async () => ({
  MessageId: 'ses-default',
  $metadata: { httpStatusCode: 200 },
}));

let sesClientConstructorCallCount = 0;
// Record args passed to the last SendEmailCommand construction
let lastSendEmailCommandParams: Record<string, unknown> | null = null;

function MockSESv2Client(_config: unknown) {
  sesClientConstructorCallCount++;
  return { send: latestClientSend };
}

function MockSendEmailCommand(params: Record<string, unknown>) {
  lastSendEmailCommandParams = params;
  return params;
}

mock.module('@aws-sdk/client-sesv2', () => ({
  SESv2Client: MockSESv2Client,
  SendEmailCommand: MockSendEmailCommand,
}));

afterEach(() => {
  sesClientConstructorCallCount = 0;
  lastSendEmailCommandParams = null;
  latestClientSend.mockReset();
  latestClientSend.mockImplementation(async () => ({
    MessageId: 'ses-default',
    $metadata: { httpStatusCode: 200 },
  }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSesProvider', () => {
  it('success → returns { status: "sent", messageId: result.MessageId }', async () => {
    latestClientSend.mockResolvedValue({
      MessageId: 'ses-123',
      $metadata: { httpStatusCode: 200 },
    });

    const provider = createSesProvider({ region: 'us-east-1' });
    const result = await provider.send({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
    });

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('ses-123');
  });

  it('SESv2Client is created once and reused across multiple send() calls', async () => {
    const provider = createSesProvider({ region: 'us-east-1' });

    await provider.send({ to: 'a@example.com', subject: 'A', html: '<p>A</p>' });
    await provider.send({ to: 'b@example.com', subject: 'B', html: '<p>B</p>' });
    await provider.send({ to: 'c@example.com', subject: 'C', html: '<p>C</p>' });

    // Client constructed exactly once regardless of send() call count
    expect(sesClientConstructorCallCount).toBe(1);
  });

  it('tags → passed to SendEmailCommand as EmailTags [{Name, Value}] pairs', async () => {
    const provider = createSesProvider({ region: 'us-east-1' });

    await provider.send({
      to: 'r@example.com',
      subject: 'Tagged',
      html: '<p>Tagged</p>',
      tags: { campaign: 'welcome', source: 'auth' },
    });

    const params = lastSendEmailCommandParams as { EmailTags?: { Name: string; Value: string }[] };
    expect(params.EmailTags).toBeDefined();
    expect(params.EmailTags).toContainEqual({ Name: 'campaign', Value: 'welcome' });
    expect(params.EmailTags).toContainEqual({ Name: 'source', Value: 'auth' });
  });

  it('no tags → EmailTags field absent from SendEmailCommand params', async () => {
    const provider = createSesProvider({ region: 'us-east-1' });

    await provider.send({ to: 'r@example.com', subject: 'S', html: '<p>S</p>' });

    const params = lastSendEmailCommandParams as { EmailTags?: unknown };
    expect(params.EmailTags).toBeUndefined();
  });

  it('headers → passed to SendEmailCommand as Content.Simple.Headers [{Name, Value}] pairs', async () => {
    const provider = createSesProvider({ region: 'us-east-1' });

    await provider.send({
      to: 'r@example.com',
      subject: 'Headered',
      html: '<p>Headered</p>',
      headers: { 'X-Custom-Id': 'abc123', 'X-Source': 'app' },
    });

    type Params = { Content?: { Simple?: { Headers?: { Name: string; Value: string }[] } } };
    const params = lastSendEmailCommandParams as Params;
    expect(params.Content?.Simple?.Headers).toBeDefined();
    expect(params.Content?.Simple?.Headers).toContainEqual({
      Name: 'X-Custom-Id',
      Value: 'abc123',
    });
    expect(params.Content?.Simple?.Headers).toContainEqual({ Name: 'X-Source', Value: 'app' });
  });

  it('no headers → Headers field absent from Content.Simple', async () => {
    const provider = createSesProvider({ region: 'us-east-1' });

    await provider.send({ to: 'r@example.com', subject: 'S', html: '<p>S</p>' });

    type Params = { Content?: { Simple?: { Headers?: unknown } } };
    const params = lastSendEmailCommandParams as Params;
    expect(params.Content?.Simple?.Headers).toBeUndefined();
  });

  it('HTTP 429 → MailSendError with retryable: true', async () => {
    const sdkError = Object.assign(new Error('Throttling'), {
      $metadata: { httpStatusCode: 429 },
    });
    latestClientSend.mockRejectedValue(sdkError);

    const provider = createSesProvider({ region: 'us-east-1' });
    const err = await provider
      .send({ to: 'r@example.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).statusCode).toBe(429);
  });

  it('HTTP 422 → MailSendError with retryable: false', async () => {
    const sdkError = Object.assign(new Error('Unprocessable'), {
      $metadata: { httpStatusCode: 422 },
    });
    latestClientSend.mockRejectedValue(sdkError);

    const provider = createSesProvider({ region: 'us-east-1' });
    const err = await provider
      .send({ to: 'r@example.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(false);
    expect((err as MailSendError).statusCode).toBe(422);
  });

  it('HTTP 500 → MailSendError with retryable: true', async () => {
    const sdkError = Object.assign(new Error('Internal Server Error'), {
      $metadata: { httpStatusCode: 500 },
    });
    latestClientSend.mockRejectedValue(sdkError);

    const provider = createSesProvider({ region: 'us-east-1' });
    const err = await provider
      .send({ to: 'r@example.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).statusCode).toBe(500);
  });

  it('no $metadata.httpStatusCode → MailSendError with retryable: true', async () => {
    const sdkError = new Error('Unknown SES error');
    latestClientSend.mockRejectedValue(sdkError);

    const provider = createSesProvider({ region: 'us-east-1' });
    const err = await provider
      .send({ to: 'r@example.com', subject: 'X', html: '<p>X</p>' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).statusCode).toBeUndefined();
  });
});
