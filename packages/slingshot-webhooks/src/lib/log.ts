/**
 * Structured-log helper used across the webhooks plugin.
 *
 * Emits a single JSON line per event with a stable shape so log aggregators
 * (Datadog, Loki, CloudWatch) can index by `endpointId`, `deliveryId`, and
 * `event`. Uses `createConsoleLogger` from slingshot-core for structured output.
 *
 * @param level - `info`, `warn`, or `error`. `error` writes to stderr.
 * @param message - Short imperative description ("delivered webhook").
 * @param fields - Structured context. Avoid PII; payloads are redacted upstream.
 */
import { createConsoleLogger } from '@lastshotlabs/slingshot-core';

const webhookLogger = createConsoleLogger({ base: { component: 'slingshot-webhooks' } });

export function logWebhookEvent(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown>,
): void {
  if (level === 'error') {
    webhookLogger.error(message, fields);
  } else if (level === 'warn') {
    webhookLogger.warn(message, fields);
  } else {
    webhookLogger.info(message, fields);
  }
}
