import type {
  SESv2Client,
  SendEmailCommand,
  SendEmailCommandInput,
  SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2';
import type {
  MailAddress,
  MailMessage,
  MailProvider,
  MailSendOptions,
  SendResult,
} from '../types/provider';
import { MailSendError } from '../types/provider';

interface SesConfig {
  region: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

type SesHandle = {
  client: SESv2Client;
  SendEmailCommand: typeof SendEmailCommand;
};

function formatAddress(addr: MailAddress): string {
  if (typeof addr === 'string') return addr;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

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
      const { client, SendEmailCommand: SESCommand } = await getSes();

      const toAddresses = Array.isArray(message.to)
        ? message.to.map(formatAddress)
        : [formatAddress(message.to)];

      const input: SendEmailCommandInput = {
        ...(message.from ? { FromEmailAddress: formatAddress(message.from) } : {}),
        Destination: { ToAddresses: toAddresses },
        Content: {
          Simple: {
            Subject: { Data: message.subject },
            Body: {
              Html: { Data: message.html },
              ...(message.text ? { Text: { Data: message.text } } : {}),
            },
            ...(message.headers
              ? {
                  Headers: Object.entries(message.headers).map(([Name, Value]) => ({
                    Name,
                    Value,
                  })),
                }
              : {}),
          },
        },
        ...(message.replyTo ? { ReplyToAddresses: [formatAddress(message.replyTo)] } : {}),
        ...(message.tags
          ? {
              EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value })),
            }
          : {}),
      };

      try {
        const result: SendEmailCommandOutput = await client.send(new SESCommand(input), {
          abortSignal: options?.signal,
        });
        return { status: 'sent', messageId: result.MessageId, raw: result };
      } catch (err) {
        const e = err as { $metadata?: { httpStatusCode?: number }; message?: string };
        const statusCode = e.$metadata?.httpStatusCode;
        const retryable = !statusCode || statusCode === 429 || statusCode >= 500;
        throw new MailSendError(
          `SES error: ${e.message ?? String(err)}`,
          retryable,
          statusCode,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    },
  };
}
