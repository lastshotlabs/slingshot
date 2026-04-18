/**
 * SES v2 smoke tests — require real AWS credentials and a verified sender.
 *
 * Run with:
 *   SES_SMOKE_REGION=us-east-1 \
 *   SES_SMOKE_FROM=verified@yourdomain.com \
 *   SES_SMOKE_TO=inbox@yourdomain.com \
 *   bun test packages/slingshot-mail/tests/smoke/ses.smoke.test.ts
 *
 * AWS credentials are sourced from the standard SDK credential chain
 * (env vars, ~/.aws/credentials, instance profile, etc.).
 *
 * If running against the SES sandbox, both FROM and TO must be verified identities.
 * Skipped automatically when any required env var is absent.
 */
import { describe, expect, it } from 'bun:test';
import { createSesProvider } from '../../src/providers/ses.js';
import { MailSendError } from '../../src/types/provider.js';

const REGION = process.env.SES_SMOKE_REGION;
const FROM = process.env.SES_SMOKE_FROM;
const TO = process.env.SES_SMOKE_TO;
const SKIP = !REGION || !FROM || !TO;

describe.skipIf(SKIP)(
  'SES v2 smoke (requires SES_SMOKE_REGION, SES_SMOKE_FROM, SES_SMOKE_TO)',
  () => {
    it('sends a basic email and returns a messageId', async () => {
      const provider = createSesProvider({ region: REGION! });

      const result = await provider.send({
        from: FROM!,
        to: TO!,
        subject: '[slingshot-mail smoke] basic send',
        html: '<p>Basic smoke test from slingshot-mail.</p>',
        text: 'Basic smoke test from slingshot-mail.',
      });

      expect(result.status).toBe('sent');
      expect(result.messageId).toBeDefined();
      expect(typeof result.messageId).toBe('string');
    });

    it('sends with custom MIME headers', async () => {
      const provider = createSesProvider({ region: REGION! });

      const result = await provider.send({
        from: FROM!,
        to: TO!,
        subject: '[slingshot-mail smoke] custom headers',
        html: '<p>Testing custom MIME headers.</p>',
        headers: {
          'X-Smoke-Test': 'true',
          'X-Source': 'slingshot-mail',
        },
      });

      expect(result.status).toBe('sent');
      expect(result.messageId).toBeDefined();
    });

    it('sends with EmailTags', async () => {
      const provider = createSesProvider({ region: REGION! });

      const result = await provider.send({
        from: FROM!,
        to: TO!,
        subject: '[slingshot-mail smoke] tags',
        html: '<p>Testing EmailTags.</p>',
        tags: {
          environment: 'smoke-test',
          source: 'slingshot-mail',
        },
      });

      expect(result.status).toBe('sent');
      expect(result.messageId).toBeDefined();
    });

    it('sends to multiple recipients', async () => {
      const provider = createSesProvider({ region: REGION! });

      const result = await provider.send({
        from: FROM!,
        to: [TO!, TO!], // same address twice — valid in SES
        subject: '[slingshot-mail smoke] multi-recipient',
        html: '<p>Multi-recipient smoke test.</p>',
      });

      expect(result.status).toBe('sent');
      expect(result.messageId).toBeDefined();
    });

    it('invalid credentials → MailSendError with retryable: false', async () => {
      const provider = createSesProvider({
        region: REGION!,
        credentials: {
          accessKeyId: 'FAKE_ACCESS_KEY_ID_FOR_TESTING',
          secretAccessKey: 'FAKE_SECRET_ACCESS_KEY_FOR_TESTING',
        },
      });

      const err = await provider
        .send({
          from: FROM!,
          to: TO!,
          subject: '[slingshot-mail smoke] invalid credentials',
          html: '<p>Should fail auth.</p>',
        })
        .catch(e => e);

      expect(err).toBeInstanceOf(MailSendError);
      expect((err as MailSendError).retryable).toBe(false);
    });
  },
);
