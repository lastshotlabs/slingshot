/**
 * An email address, expressed either as a bare address string or a structured object.
 *
 * @example
 * ```ts
 * const bare: MailAddress = 'alice@example.com';
 * const named: MailAddress = { name: 'Alice', email: 'alice@example.com' };
 * ```
 */
export type MailAddress = string | { name?: string; email: string };

/**
 * A fully-resolved email message ready to be handed to a `MailProvider`.
 *
 * The `html` field is required; providers that support a text fallback will use `text`
 * when present. `from` overrides the plugin-level default when set.
 */
export interface MailMessage {
  /** Sender address. Overrides the plugin-level `config.from` when set. */
  from?: MailAddress;
  /** One or more recipient addresses. */
  to: MailAddress | MailAddress[];
  /** Email subject line. */
  subject: string;
  /** HTML body of the email. */
  html: string;
  /** Optional plain-text fallback body. */
  text?: string;
  /** Reply-to address forwarded to the provider. */
  replyTo?: MailAddress;
  /** Custom headers forwarded verbatim to the provider. */
  headers?: Record<string, string>;
  /** Provider-specific tags for analytics/filtering. */
  tags?: Record<string, string>;
}

/**
 * The result returned by a `MailProvider` after attempting to send a message.
 *
 * - `sent` — provider accepted and transmitted the message.
 * - `queued_by_provider` — provider accepted and will deliver asynchronously (e.g. SendGrid).
 * - `rejected` — provider accepted the request but explicitly rejected the message (e.g. hard
 *   bounce rules). The message should be dead-lettered, not retried.
 */
export interface SendResult {
  /** Delivery outcome from the provider's perspective. */
  status: 'sent' | 'queued_by_provider' | 'rejected';
  /** Provider-assigned message identifier, useful for delivery tracking. */
  messageId?: string;
  /** Raw provider response, for debugging. May be `null` if the provider gives no body. */
  raw?: object | null;
}

export interface MailSendOptions {
  /** Aborted when the queue-level send timeout expires. Providers should pass it to fetch/SDK calls. */
  signal?: AbortSignal;
}

/**
 * Thrown by `MailProvider.send()` when delivery fails.
 *
 * The `retryable` flag controls queue behaviour: non-retryable errors (e.g. invalid recipient,
 * API auth failure) are dead-lettered immediately; retryable errors (e.g. rate limit, 5xx) are
 * re-enqueued up to `config.queueConfig.maxAttempts`.
 *
 * @example
 * ```ts
 * try {
 *   await provider.send(message);
 * } catch (err) {
 *   if (err instanceof MailSendError && !err.retryable) {
 *     console.error('Permanent send failure:', err.message, err.statusCode);
 *   }
 * }
 * ```
 */
export class MailSendError extends Error {
  /** Milliseconds the caller should wait before retrying, parsed from a `Retry-After` header. */
  public readonly retryAfterMs?: number;

  /**
   * @param message - Human-readable error message.
   * @param retryable - Whether the queue should retry this job.
   * @param statusCode - HTTP status code from the provider, if available.
   * @param providerError - Raw error from the provider SDK, if available.
   * @param retryAfterMs - Hint from the provider's `Retry-After` header, in milliseconds.
   */
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly providerError?: Error | string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MailSendError';
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Interface that every mail transport adapter must implement.
 *
 * Implementations are provided for Resend, SES, Postmark, and SendGrid. Implement this
 * interface directly to support a custom transport.
 *
 * @remarks
 * `send()` must throw `MailSendError` with `retryable` set correctly so the queue can
 * make an informed retry decision. Non-`MailSendError` rejections are treated as retryable.
 */
export interface MailProvider {
  /** Unique provider name used in logs and diagnostics (e.g. `'resend'`). */
  name: string;
  /**
   * Attempt to send a single message.
   * @param message - The fully-resolved message to send.
   * @returns A `SendResult` describing the outcome.
   * @throws {MailSendError} On delivery failure. Set `retryable: false` for permanent failures.
   */
  send(message: MailMessage, options?: MailSendOptions): Promise<SendResult>;
  /**
   * Optional startup connectivity check. Called once during plugin activation.
   * Should throw if the provider cannot be reached or credentials are invalid.
   */
  healthCheck?(): Promise<void>;
}
