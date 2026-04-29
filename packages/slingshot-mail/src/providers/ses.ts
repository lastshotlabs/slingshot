import type {
  SESv2Client,
  SendEmailCommand,
  SendEmailCommandInput,
  SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2';
import { createMailCircuitBreaker } from '../lib/circuitBreaker';
import type { MailCircuitBreakerOptions } from '../lib/circuitBreaker';
import { assertSafeMailHeaders, ensureSafe, formatSafeAddress } from '../lib/headerSanitize';
import { extractRetryAfterHeader, parseRetryAfterMs } from '../lib/retryAfter';
import type { MailMessage, MailProvider, MailSendOptions, SendResult } from '../types/provider';
import { MailSendError } from '../types/provider';

interface SesConfig {
  region: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /**
   * Maximum milliseconds a single SDK send may run before the request is
   * aborted with a retryable timeout error. Default: 30000.
   */
  providerTimeoutMs?: number;
  /** Override or disable the consecutive-failure circuit breaker. */
  circuitBreaker?: Pick<MailCircuitBreakerOptions, 'threshold' | 'cooldownMs' | 'now'>;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

type SesHandle = {
  client: SESv2Client;
  SendEmailCommand: typeof SendEmailCommand;
};

/**
 * Creates a `MailProvider` backed by AWS SES v2 (`@aws-sdk/client-sesv2`).
 *
 * The AWS SDK is loaded lazily on first send — install `@aws-sdk/client-sesv2` as a peer
 * dependency. Credentials can be provided explicitly or resolved from the environment
 * (IAM roles, `~/.aws/credentials`, etc.).
 *
 * @param config - AWS region and optional static credentials.
 * @returns A `MailProvider` instance ready to pass to `createMailPlugin`.
 * @throws {MailSendError} If `@aws-sdk/client-sesv2` is not installed (non-retryable).
 *
 * @example
 * ```ts
 * import { createSesProvider } from '@lastshotlabs/slingshot-mail';
 *
 * const provider = createSesProvider({ region: 'us-east-1' });
 * // Or with explicit credentials:
 * const provider = createSesProvider({
 *   region: 'eu-west-1',
 *   credentials: { accessKeyId: process.env.AWS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET! },
 * });
 * ```
 */
export function createSesProvider(config: SesConfig): MailProvider {
  let _ses: SesHandle | null = null;
  const providerTimeoutMs = config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const breaker = createMailCircuitBreaker({
    providerName: 'ses',
    ...(config.circuitBreaker ?? {}),
  });

  async function getSes(): Promise<SesHandle> {
    if (_ses) return _ses;
    try {
      const mod = await import('@aws-sdk/client-sesv2');
      _ses = {
        client: new mod.SESv2Client({
          region: config.region,
          ...(config.credentials ? { credentials: config.credentials } : {}),
        }),
        SendEmailCommand: mod.SendEmailCommand,
      };
      return _ses;
    } catch {
      throw new MailSendError('SES provider requires @aws-sdk/client-sesv2 to be installed', false);
    }
  }

  return {
    name: 'ses',
    async send(message: MailMessage, options?: MailSendOptions): Promise<SendResult> {
      return breaker.guard(async () => {
        // Reject CR/LF/NUL injection in any header-bound field before
        // handing the message to the SES SDK; the v2 API surfaces these
        // values as SMTP headers and an unsanitized newline would forge
        // additional message headers on the wire.
        assertSafeMailHeaders(message);
        const { client, SendEmailCommand: SESCommand } = await getSes();

        const toAddresses = Array.isArray(message.to)
          ? message.to.map(addr => formatSafeAddress(addr, 'To'))
          : [formatSafeAddress(message.to, 'To')];

        const input: SendEmailCommandInput = {
          ...(message.from ? { FromEmailAddress: formatSafeAddress(message.from, 'From') } : {}),
          Destination: { ToAddresses: toAddresses },
          Content: {
            Simple: {
              Subject: { Data: ensureSafe(message.subject, 'Subject') },
              Body: {
                Html: { Data: message.html },
                ...(message.text ? { Text: { Data: message.text } } : {}),
              },
              ...(message.headers
                ? {
                    Headers: Object.entries(message.headers).map(([Name, Value]) => ({
                      Name,
                      Value: ensureSafe(Value, Name),
                    })),
                  }
                : {}),
            },
          },
          ...(message.replyTo
            ? { ReplyToAddresses: [formatSafeAddress(message.replyTo, 'Reply-To')] }
            : {}),
          ...(message.tags
            ? {
                EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value })),
              }
            : {}),
        };

        // Combine caller's signal with our own timeout signal. SES SDK accepts
        // a single AbortSignal so we union via a controller.
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
                () =>
                  controller.abort(
                    new Error(`ses provider timed out after ${providerTimeoutMs}ms`),
                  ),
                providerTimeoutMs,
              )
            : undefined;
        try {
          const result: SendEmailCommandOutput = await client.send(new SESCommand(input), {
            abortSignal: controller.signal,
          });
          return { status: 'sent', messageId: result.MessageId, raw: result };
        } catch (err) {
          if (controller.signal.aborted && !callerSignal?.aborted) {
            throw new MailSendError(`SES provider timed out after ${providerTimeoutMs}ms`, true);
          }
          const e = err as {
            $metadata?: { httpStatusCode?: number };
            $response?: { headers?: unknown };
            message?: string;
          };
          const statusCode = e.$metadata?.httpStatusCode;
          const retryable = !statusCode || statusCode === 429 || statusCode >= 500;
          const retryAfterMs = parseRetryAfterMs(extractRetryAfterHeader(e.$response?.headers));
          throw new MailSendError(
            `SES error: ${e.message ?? String(err)}`,
            retryable,
            statusCode,
            err instanceof Error ? err : new Error(String(err)),
            retryAfterMs,
          );
        } finally {
          if (timer) clearTimeout(timer);
          if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
        }
      });
    },
  };
}
