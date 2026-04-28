/**
 * SES error path with Retry-After header on the SDK error's `$response`.
 * Lives in its own file so the SES SDK module mock cannot bleed into other
 * provider tests (see CLAUDE memory: mock.module + isolation rule).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { MailSendError } from '../../src/types/provider.js';

const sesSend: ReturnType<typeof mock> = mock(async () => ({}));

mock.module('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    send = sesSend;
  },
  SendEmailCommand: class {
    constructor(public params: unknown) {}
  },
}));

afterEach(() => {
  sesSend.mockReset();
});

describe('createSesProvider — Retry-After propagation', () => {
  it('429 with $response.headers.retry-after → retryAfterMs is set', async () => {
    const sdkError = Object.assign(new Error('Throttling'), {
      $metadata: { httpStatusCode: 429 },
      $response: { headers: { 'retry-after': '8' } },
    });
    sesSend.mockRejectedValue(sdkError);

    const sesModulePath = '../../src/providers/ses.js?ses-retry';
    const { createSesProvider } = await import(sesModulePath);
    const provider = createSesProvider({ region: 'us-east-1' });
    const err = await provider
      .send({ to: 'r@example.com', subject: 'X', html: '<p>X</p>' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).statusCode).toBe(429);
    expect((err as MailSendError).retryAfterMs).toBe(8_000);
  });

  it('500 with no Retry-After header → retryAfterMs undefined', async () => {
    const sdkError = Object.assign(new Error('boom'), {
      $metadata: { httpStatusCode: 500 },
    });
    sesSend.mockRejectedValue(sdkError);

    const sesModulePath = '../../src/providers/ses.js?ses-retry';
    const { createSesProvider } = await import(sesModulePath);
    const provider = createSesProvider({ region: 'us-east-1' });
    const err = await provider
      .send({ to: 'r@example.com', subject: 'X', html: '<p>X</p>' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(true);
    expect((err as MailSendError).retryAfterMs).toBeUndefined();
  });
});
