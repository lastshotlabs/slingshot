/**
 * Error taxonomy for `slingshot-ai`.
 *
 * Consumers catch THESE classes — never a provider SDK's own error types. Each
 * adapter maps its SDK errors into this taxonomy (most-specific-first, never by
 * string-matching), which is what lets an app swap Anthropic for a local model
 * without touching a single catch block.
 *
 * The throw-vs-return rule:
 *   - THROW when the call produced no usable result through no choice of the
 *     caller (bad config, spend limit, rate limit after retries, connection
 *     failure, unparseable structured output, refusal, timeout).
 *   - RETURN when the system worked and made a decision the caller may want to
 *     inspect (moderation verdicts, degradations, usage, `stopReason:
 *     'max_tokens'` — the caller decides whether truncation matters).
 */

/** Machine-readable discriminator carried by every error in the taxonomy. */
export type AiErrorCode =
  | 'ai_config'
  | 'ai_provider'
  | 'ai_rate_limit'
  | 'ai_refusal'
  | 'ai_structured_output'
  | 'ai_content_blocked'
  | 'ai_spend_limit'
  | 'ai_unsupported_feature'
  | 'ai_timeout';

/** Base class for every error the package throws. */
export class AiError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.code = code;
    this.name = new.target.name;
  }
}

/**
 * Invalid configuration: unknown provider kind, missing API key for a
 * configured provider, an undefined moderation policy, a `defaultProvider` that
 * names no configured provider. Always thrown at boot or at call-construction
 * time — never mid-flight.
 */
export class AiConfigError extends AiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ai_config', message, options);
  }
}

/**
 * A provider returned an error. Wraps the underlying SDK/HTTP failure.
 *
 * `retryable` is the adapter's judgment, and the retry layer honors it — a 400
 * is never retried, a connection reset always is.
 */
export class AiProviderError extends AiError {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly providerKind: string;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      status?: number | null;
      providerKind: string;
      cause?: unknown;
    },
  ) {
    super('ai_provider', message, { cause: options.cause });
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.providerKind = options.providerKind;
  }
}

/** Rate limited. `retryAfterMs` comes from the provider when it supplies one. */
export class AiRateLimitError extends AiProviderError {
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      providerKind: string;
      retryAfterMs?: number | null;
      status?: number | null;
      cause?: unknown;
    },
  ) {
    super(message, {
      retryable: true,
      status: options.status ?? 429,
      providerKind: options.providerKind,
      cause: options.cause,
    });
    // Re-tag: the base class set 'ai_provider'.
    (this as { code: AiErrorCode }).code = 'ai_rate_limit';
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/**
 * The model declined the request (Anthropic's `stop_reason: 'refusal'`, which
 * arrives as an HTTP 200 with empty or partial content — hence a distinct class
 * rather than a provider error).
 */
export class AiRefusalError extends AiError {
  /** Provider-supplied policy category, when one is given. Often null. */
  readonly category: string | null;
  /** Any partial text the model emitted before refusing. Usually empty. */
  readonly partialText: string;

  constructor(
    message: string,
    options?: { category?: string | null; partialText?: string; cause?: unknown },
  ) {
    super('ai_refusal', message, { cause: options?.cause });
    this.category = options?.category ?? null;
    this.partialText = options?.partialText ?? '';
  }
}

/**
 * The model's output could not be coerced into the requested schema, even after
 * the repair loop. Carries the raw text and the final Zod error so the caller
 * can log what actually came back — the single most useful thing to see when a
 * local model misbehaves.
 */
export class AiStructuredOutputError extends AiError {
  readonly rawText: string;
  readonly zodError: unknown;
  readonly attempts: number;

  constructor(
    message: string,
    options: { rawText: string; zodError?: unknown; attempts: number; cause?: unknown },
  ) {
    super('ai_structured_output', message, { cause: options.cause });
    this.rawText = options.rawText;
    this.zodError = options.zodError ?? null;
    this.attempts = options.attempts;
  }
}

/** Moderation blocked the content and the request asked for `onBlocked: 'throw'`. */
export class AiContentBlockedError extends AiError {
  readonly categories: readonly string[];
  readonly severity: string;
  readonly reason: string;

  constructor(
    message: string,
    options: { categories: readonly string[]; severity: string; reason: string },
  ) {
    super('ai_content_blocked', message);
    this.categories = options.categories;
    this.severity = options.severity;
    this.reason = options.reason;
  }
}

/**
 * The pre-flight spend guard refused the call.
 *
 * Thrown BEFORE the HTTP request — a post-hoc check notices a runaway loop, a
 * pre-flight check stops it.
 */
export class AiSpendLimitError extends AiError {
  readonly spentUsd: number;
  readonly limitUsd: number;
  /** `null` when the call could not be priced — we blocked on the known spend alone. */
  readonly estimatedUsd: number | null;
  readonly period: string;

  constructor(
    message: string,
    options: { spentUsd: number; limitUsd: number; estimatedUsd: number | null; period: string },
  ) {
    super('ai_spend_limit', message);
    this.spentUsd = options.spentUsd;
    this.limitUsd = options.limitUsd;
    this.estimatedUsd = options.estimatedUsd;
    this.period = options.period;
  }
}

/**
 * The caller asked for a feature the selected provider does not support, and
 * the package is configured with `degradation: 'strict'`.
 *
 * Under the default `degradation: 'warn'` this is NOT thrown — the orchestrator
 * degrades and records an `AiDegradation` on the result instead.
 */
export class AiUnsupportedFeatureError extends AiError {
  readonly feature: string;
  readonly provider: string;

  constructor(message: string, options: { feature: string; provider: string }) {
    super('ai_unsupported_feature', message);
    this.feature = options.feature;
    this.provider = options.provider;
  }
}

/** The request exceeded `timeoutMs`. */
export class AiTimeoutError extends AiError {
  readonly timeoutMs: number;

  constructor(message: string, options: { timeoutMs: number; cause?: unknown }) {
    super('ai_timeout', message, { cause: options.cause });
    this.timeoutMs = options.timeoutMs;
  }
}
