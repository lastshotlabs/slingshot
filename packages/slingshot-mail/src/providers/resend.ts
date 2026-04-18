import type { MailAddress, MailMessage, MailProvider, SendResult } from '../types/provider';
import { MailSendError } from '../types/provider';

interface ResendConfig {
  apiKey: string;
  baseUrl?: string;
}

interface ResendBody {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  text?: string;
  reply_to?: string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
}

function formatAddress(addr: MailAddress): string {
  if (typeof addr === 'string') return addr;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

function formatAddresses(addr: MailAddress | MailAddress[]): string | string[] {
  if (Array.isArray(addr)) return addr.map(formatAddress);
  return formatAddress(addr);
}

/**
 * Creates a `MailProvider` backed by the [Resend](https://resend.com) API.
 *
 * Uses the `POST /emails` endpoint directly via `fetch` — no SDK dependency required.
 * Rate-limit (429) and server errors (5xx) are marked retryable; all other failures are
 * treated as permanent.
 *
 * @param config - Resend API key and optional base URL override (useful for testing).
 * @returns A `MailProvider` instance ready to pass to `createMailPlugin`.
 *
 * @example
 * ```ts
 * import { createResendProvider } from '@lastshotlabs/slingshot-mail';
 *
 * const provider = createResendProvider({ apiKey: process.env.RESEND_API_KEY! });
 * ```
 */
export function createResendProvider(config: ResendConfig): MailProvider {
  const baseUrl = config.baseUrl ?? 'https://api.resend.com';

  return {
    name: 'resend',
    async send(message: MailMessage): Promise<SendResult> {
      const body: ResendBody = {
        to: formatAddresses(message.to),
        subject: message.subject,
        html: message.html,
        ...(message.from ? { from: formatAddress(message.from) } : {}),
        ...(message.text ? { text: message.text } : {}),
        ...(message.replyTo ? { reply_to: formatAddress(message.replyTo) } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        ...(message.tags
          ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) }
          : {}),
      };

      const res = await fetch(`${baseUrl}/emails`, {
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
        throw new MailSendError(`Resend error ${res.status}: ${text}`, retryable, res.status, text);
      }

      const data = (await res.json()) as { id?: string };
      return { status: 'sent', messageId: data.id, raw: data };
    },
  };
}
