import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
import { MailCircuitOpenError } from './circuitBreaker';
import { MailSendError } from '../types/provider';

/**
 * Classification result for a mail send failure.
 *
 * - `transient` — retry with backoff. Covers 408/429/5xx and network-level
 *   errors that have a reasonable chance of succeeding on retry.
 * - `permanent` — surface to the dead-letter sink immediately. Covers 4xx
 *   responses other than 408/429, template-not-found, and explicit
 *   non-retryable provider errors.
 * - `circuitOpen` — provider is in cool-down; treat as transient retry but
 *   without consuming an attempt against the same provider.
 */
export type MailFailureClass = 'transient' | 'permanent' | 'circuitOpen';

/**
 * Map an error thrown by a mail provider into a transient/permanent class
 * the queue can use to decide retry vs dead-letter behaviour. The rules:
 *
 * - 408 / 429 / 5xx and network-level errors → transient.
 * - Any other 4xx → permanent.
 * - `MailSendError` with `retryable=false` → permanent.
 * - `TemplateNotFoundError` → permanent.
 * - `MailCircuitOpenError` → `circuitOpen`.
 * - Anything else (non-MailSendError) defaults to transient so unknown errors
 *   do not silently dead-letter user mail.
 */
export function classifyMailFailure(err: unknown): MailFailureClass {
  if (err instanceof MailCircuitOpenError) return 'circuitOpen';
  if (err instanceof TemplateNotFoundError) return 'permanent';
  if (err instanceof MailSendError) {
    const status = err.statusCode;
    if (typeof status === 'number') {
      if (status === 408 || status === 429 || status >= 500) return 'transient';
      if (status >= 400) return 'permanent';
    }
    return err.retryable ? 'transient' : 'permanent';
  }
  // Network-level errors (DNS, ECONNREFUSED, fetch TypeError) → transient.
  return 'transient';
}

const DEFAULT_RETRY_DELAY_MS = [1_000, 4_000, 16_000];

/**
 * Backoff delay (ms) for the n-th attempt (1-indexed). Defaults to
 * 1s / 4s / 16s for attempts 1, 2, 3 respectively. Beyond 3 retries the
 * sequence holds at the last value rather than growing unbounded.
 *
 * `baseDelayMs` overrides the schedule — when provided, the n-th retry
 * waits `baseDelayMs * 4^(n-1)` (1x, 4x, 16x) up to 60s. Set to 0 to
 * disable the wait entirely (test-only).
 *
 * Honours a provider-supplied `retryAfterMs` hint when present — the hint
 * takes priority over the default schedule but is clamped to 60s so a
 * misbehaving provider can't hold the worker for hours.
 */
export function retryDelayFor(
  attempt: number,
  retryAfterMs?: number,
  baseDelayMs?: number,
): number {
  if (baseDelayMs !== undefined) {
    if (baseDelayMs <= 0) return 0;
    const idx = Math.max(0, Math.min(attempt - 1, 2));
    const multiplier = [1, 4, 16][idx]!;
    const baseline = Math.min(baseDelayMs * multiplier, 60_000);
    if (retryAfterMs === undefined) return baseline;
    return Math.max(baseline, Math.min(retryAfterMs, 60_000));
  }
  const idx = Math.max(0, Math.min(attempt - 1, DEFAULT_RETRY_DELAY_MS.length - 1));
  const baseline = DEFAULT_RETRY_DELAY_MS[idx]!;
  if (retryAfterMs === undefined) return baseline;
  return Math.max(baseline, Math.min(retryAfterMs, 60_000));
}
