/**
 * Tests createSesProvider when @aws-sdk/client-sesv2 is not installed.
 * Uses a local module mock so the failure simulation cannot leak into other files.
 */
import { describe, expect, it, mock } from 'bun:test';
import { MailSendError } from '../../src/types/provider.js';

describe('createSesProvider (SDK not installed)', () => {
  it('SDK not installed → MailSendError with retryable: false, message includes @aws-sdk/client-sesv2', async () => {
    mock.module('@aws-sdk/client-sesv2', () => ({
      SESv2Client: class {
        constructor() {
          throw new Error('@aws-sdk/client-sesv2 is not installed');
        }
      },
      SendEmailCommand: class {
        constructor() {}
      },
    }));

    try {
      const sesModulePath = '../../src/providers/ses.js?missing-sdk';
      const { createSesProvider } = await import(sesModulePath);
      const provider = createSesProvider({ region: 'us-east-1' });
      const err = await provider
        .send({
          to: 'r@example.com',
          subject: 'X',
          html: '<p>X</p>',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MailSendError);
      expect((err as MailSendError).retryable).toBe(false);
      expect((err as MailSendError).message).toContain('@aws-sdk/client-sesv2');
    } finally {
      mock.restore();
    }
  });
});
