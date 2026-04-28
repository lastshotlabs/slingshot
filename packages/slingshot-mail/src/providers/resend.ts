import { createMailCircuitBreaker } from '../lib/circuitBreaker';
import type { MailCircuitBreakerOptions } from '../lib/circuitBreaker';
import { assertSafeMailHeaders, ensureSafe, formatSafeAddress } from '../lib/headerSanitize';
import { extractRetryAfterHeader, parseRetryAfterMs } from '../lib/retryAfter';
import type {
  MailAddress,
  MailMessage,
  MailProvider,
  MailSendOptions,
  SendResult,
} from '../types/provider';
import { MailSendError } from '../types/provider';

interface ResendConfig {
  apiKey: string;
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

function formatAddresses(
  addr: MailAddress | MailAddress[],
  header: string,
): string | string[] {
  if (Array.isArray(addr)) return addr.map(item => formatSafeAddress(item, header));
  return formatSafeAddress(addr, header);
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
  const providerTimeoutMs = config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const breaker = createMailCircuitBreaker({
    providerName: 'resend',
    ...(config.circuitBreaker ?? {}),
  });

  return {
    name: 'resend',
    async send(message: MailMessage, options?: MailSendOptions): Promise<SendResult> {
      return breaker.guard(async () => {
        // Reject CR/LF/NUL injection in any header-bound field before
        // sending. Resend's HTTP API treats Subject and address fields
        // as headers; an unsanitized newline would forge additional
        // message headers on the wire.
        assertSafeMailHeaders(message);
        const sanitizedHeaders = message.headers
          ? Object.fromEntries(
              Object.entries(message.headers).map(([name, value]) => [
                name,
                ensureSafe(value, name),
              ]),
            )
          : undefined;
        const body: ResendBody = {
          to: formatAddresses(message.to, 'to'),
          subject: ensureSafe(message.subject, 'Subject'),
          html: message.html,
          ...(message.from ? { from: formatSafeAddress(message.from, 'from') } : {}),
          ...(message.text ? { text: message.text } : {}),
          ...(message.replyTo ? { reply_to: formatSafeAddress(message.replyTo, 'reply_to') } : {}),
          ...(sanitizedHeaders ? { headers: sanitizedHeaders } : {}),
          ...(message.tags
            ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) }
            : {}),
        };

        // Bind a per-request AbortController so we can apply a provider-level
        // timeout while still respecting any caller-supplied signal. We avoid
        // AbortSignal.any() because it is not yet broadly available in the
        // runtimes we target.
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
                () => controller.abort(new Error(`resend provider timed out after ${providerTimeoutMs}ms`)),
                providerTimeoutMs,
              )
            : undefined;
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/emails`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          if (controller.signal.aborted && !callerSignal?.aborted) {
            throw new MailSendError(
              `Resend provider timed out after ${providerTimeoutMs}ms`,
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
            `Resend error ${res.status}: ${text}`,
            retryable,
            res.status,
            text,
            retryAfterMs,
          );
        }

        const data = (await res.json()) as { id?: string };
        return { status: 'sent', messageId: data.id, raw: data };
      });
    },
  };
}
