import type { MailAddress, MailMessage, MailProvider, SendResult } from '../types/provider';
import { MailSendError } from '../types/provider';

interface SendgridConfig {
  apiKey: string;
  baseUrl?: string;
}

type SgAddress = { email: string; name?: string };

interface SendGridBody {
  personalizations: Array<{ to: SgAddress[] }>;
  subject: string;
  content: Array<{ type: string; value: string }>;
  from?: SgAddress;
  reply_to?: SgAddress;
  headers?: Record<string, string>;
}

function toSgAddress(addr: MailAddress): SgAddress {
  if (typeof addr === 'string') return { email: addr };
  return { email: addr.email, ...(addr.name ? { name: addr.name } : {}) };
}

/**
 * Creates a `MailProvider` backed by the [SendGrid](https://sendgrid.com) Mail Send API v3.
 *
 * Uses the `POST /v3/mail/send` endpoint directly via `fetch` — no SDK dependency required.
 * SendGrid returns HTTP 202 Accepted for queued messages, so `SendResult.status` is always
 * `'sent'` (delivery is async on SendGrid's end). Rate-limit (429) and server errors (5xx)
 * are marked retryable.
 *
 * @param config - SendGrid API key and optional base URL override.
 * @returns A `MailProvider` instance ready to pass to `createMailPlugin`.
 *
 * @example
 * ```ts
 * import { createSendgridProvider } from '@lastshotlabs/slingshot-mail';
 *
 * const provider = createSendgridProvider({ apiKey: process.env.SENDGRID_API_KEY! });
 * ```
 */
export function createSendgridProvider(config: SendgridConfig): MailProvider {
  const baseUrl = config.baseUrl ?? 'https://api.sendgrid.com';

  return {
    name: 'sendgrid',
    async send(message: MailMessage): Promise<SendResult> {
      const toAddresses = Array.isArray(message.to)
        ? message.to.map(toSgAddress)
        : [toSgAddress(message.to)];

      const body: SendGridBody = {
        personalizations: [{ to: toAddresses }],
        subject: message.subject,
        content: [
          { type: 'text/html', value: message.html },
          ...(message.text ? [{ type: 'text/plain', value: message.text }] : []),
        ],
        ...(message.from ? { from: toSgAddress(message.from) } : {}),
        ...(message.replyTo ? { reply_to: toSgAddress(message.replyTo) } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
      };

      const res = await fetch(`${baseUrl}/v3/mail/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const text = await res.text().catch(() => '');
        throw new MailSendError(
          `SendGrid error ${res.status}: ${text}`,
          retryable,
          res.status,
          text,
        );
      }

      const messageId = res.headers.get('x-message-id') ?? undefined;
      return { status: 'sent', messageId, raw: null };
    },
  };
}
