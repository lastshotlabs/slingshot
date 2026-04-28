import { createMailCircuitBreaker } from '../lib/circuitBreaker';
import type { MailCircuitBreakerOptions } from '../lib/circuitBreaker';
import { assertSafeMailHeaders, ensureSafe, formatSafeAddress } from '../lib/headerSanitize';
import { extractRetryAfterHeader, parseRetryAfterMs } from '../lib/retryAfter';
import type {
  MailMessage,
  MailProvider,
  MailSendOptions,
  SendResult,
} from '../types/provider';
import { MailSendError } from '../types/provider';

interface PostmarkConfig {
  serverToken: string;
  baseUrl?: string;
  /**
   * Maximum milliseconds a single HTTP send may run before the request is
   * aborted with a retryable timeout error. Default: 30000.
   */
  providerTimeoutMs?: number;
  /** Override or disable the consecutive-failure circuit breaker. */
  circuitBreaker?: Pick<MailCircuitBreakerOptions, 'threshold' | 'cooldownMs' | 'now'>;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

interface PostmarkBody {
  To: string;
  Subject: string;
  HtmlBody: string;
  From?: string;
  TextBody?: string;
  ReplyTo?: string;
  Headers?: Array<{ Name: string; Value: string }>;
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
  const providerTimeoutMs = config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const breaker = createMailCircuitBreaker({
    providerName: 'postmark',
    ...(config.circuitBreaker ?? {}),
  });

  return {
    name: 'postmark',
    async send(message: MailMessage, options?: MailSendOptions): Promise<SendResult> {
      return breaker.guard(async () => {
        // Reject CR/LF/NUL injection in any header-bound field before
        // sending. Postmark's HTTP API treats Subject and address fields
        // as headers; an unsanitized newline would forge additional
        // message headers (e.g. Bcc) on the wire.
        assertSafeMailHeaders(message);
        const to = Array.isArray(message.to)
          ? message.to.map(addr => formatSafeAddress(addr, 'To')).join(', ')
          : formatSafeAddress(message.to, 'To');

        const body: PostmarkBody = {
          To: to,
          Subject: ensureSafe(message.subject, 'Subject'),
          HtmlBody: message.html,
          ...(message.from ? { From: formatSafeAddress(message.from, 'From') } : {}),
          ...(message.text ? { TextBody: message.text } : {}),
          ...(message.replyTo ? { ReplyTo: formatSafeAddress(message.replyTo, 'Reply-To') } : {}),
          ...(message.headers
            ? {
                Headers: Object.entries(message.headers).map(([Name, Value]) => ({
                  Name,
                  Value: ensureSafe(Value, Name),
                })),
              }
            : {}),
        };

        const controller = new AbortController();
        const callerSignal = options?.signal;
        const onCallerAbort = () => controller.abort(callerSignal?.reason);
        if (callerSignal) {
          if (callerSignal.aborted) controller.abort(callerSignal.reason);
          else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        }
        const timer =
          providerTimeoutMs > 0
            ? setTimeout(
                () => controller.abort(new Error(`postmark provider timed out after ${providerTimeoutMs}ms`)),
                providerTimeoutMs,
              )
            : undefined;
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/email`, {
            method: 'POST',
            headers: {
              'X-Postmark-Server-Token': config.serverToken,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          if (controller.signal.aborted && !callerSignal?.aborted) {
            throw new MailSendError(
              `Postmark provider timed out after ${providerTimeoutMs}ms`,
              true,
            );
          }
          throw err;
        } finally {
          if (timer) clearTimeout(timer);
          if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
        }

        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          const text = await res.text().catch(() => '');
          const retryAfterMs = parseRetryAfterMs(extractRetryAfterHeader(res.headers));
          throw new MailSendError(
            `Postmark error ${res.status}: ${text}`,
            retryable,
            res.status,
            text,
            retryAfterMs,
          );
        }

        const data = (await res.json()) as { MessageID?: string };
        return { status: 'sent', messageId: data.MessageID, raw: data };
      });
    },
  };
}
