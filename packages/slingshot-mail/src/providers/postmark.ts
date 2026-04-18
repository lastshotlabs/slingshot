import type { MailAddress, MailMessage, MailProvider, SendResult } from '../types/provider';
import { MailSendError } from '../types/provider';

interface PostmarkConfig {
  serverToken: string;
  baseUrl?: string;
}

interface PostmarkBody {
  To: string;
  Subject: string;
  HtmlBody: string;
  From?: string;
  TextBody?: string;
  ReplyTo?: string;
  Headers?: Array<{ Name: string; Value: string }>;
}

function formatAddress(addr: MailAddress): string {
  if (typeof addr === 'string') return addr;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

/**
 * Creates a `MailProvider` backed by the [Postmark](https://postmarkapp.com) API.
 *
 * Uses the `POST /email` endpoint directly via `fetch` — no SDK dependency required.
 * Rate-limit (429) and server errors (5xx) are marked retryable; all other failures are
 * treated as permanent.
 *
 * @param config - Postmark server token and optional base URL override.
 * @returns A `MailProvider` instance ready to pass to `createMailPlugin`.
 *
 * @example
 * ```ts
 * import { createPostmarkProvider } from '@lastshotlabs/slingshot-mail';
 *
 * const provider = createPostmarkProvider({ serverToken: process.env.POSTMARK_TOKEN! });
 * ```
 */
export function createPostmarkProvider(config: PostmarkConfig): MailProvider {
  const baseUrl = config.baseUrl ?? 'https://api.postmarkapp.com';

  return {
    name: 'postmark',
    async send(message: MailMessage): Promise<SendResult> {
      const to = Array.isArray(message.to)
        ? message.to.map(formatAddress).join(', ')
        : formatAddress(message.to);

      const body: PostmarkBody = {
        To: to,
        Subject: message.subject,
        HtmlBody: message.html,
        ...(message.from ? { From: formatAddress(message.from) } : {}),
        ...(message.text ? { TextBody: message.text } : {}),
        ...(message.replyTo ? { ReplyTo: formatAddress(message.replyTo) } : {}),
        ...(message.headers
          ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
          : {}),
      };

      const res = await fetch(`${baseUrl}/email`, {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': config.serverToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const text = await res.text().catch(() => '');
        throw new MailSendError(
          `Postmark error ${res.status}: ${text}`,
          retryable,
          res.status,
          text,
        );
      }

      const data = (await res.json()) as { MessageID?: string };
      return { status: 'sent', messageId: data.MessageID, raw: data };
    },
  };
}
