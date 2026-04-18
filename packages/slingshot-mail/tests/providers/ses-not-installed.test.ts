/**
 * Tests createSesProvider when @aws-sdk/client-sesv2 is not installed.
 * Must be isolated in its own file because mock.module() must be set
 * before the first import of the module under test, and Bun caches modules.
 */
import { describe, expect, it, mock } from 'bun:test';
import { createSesProvider } from '../../src/providers/ses.js';
import { MailSendError } from '../../src/types/provider.js';

// Simulate SDK not installed — mock BEFORE importing provider
mock.module('@aws-sdk/client-sesv2', () => {
  throw new Error('@aws-sdk/client-sesv2 is not installed');
});

describe('createSesProvider (SDK not installed)', () => {
  it('SDK not installed → MailSendError with retryable: false, message includes @aws-sdk/client-sesv2', async () => {
    const provider = createSesProvider({ region: 'us-east-1' });
    const err = await provider
      .send({
        to: 'r@example.com',
        subject: 'X',
        html: '<p>X</p>',
      })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).retryable).toBe(false);
    expect((err as MailSendError).message).toContain('@aws-sdk/client-sesv2');
  });
});
