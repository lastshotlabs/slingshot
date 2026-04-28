/**
 * Structured-log helper used across the webhooks plugin.
 *
 * Emits a single JSON line per event with a stable shape so log aggregators
 * (Datadog, Loki, CloudWatch) can index by `endpointId`, `deliveryId`, and
 * `event`. The shape is deliberately minimal — callers add domain-specific
 * fields via the `fields` argument.
 *
 * @param level - `info`, `warn`, or `error`. `error` writes to stderr.
 * @param message - Short imperative description ("delivered webhook").
 * @param fields - Structured context. Avoid PII; payloads are redacted upstream.
 */
export function logWebhookEvent(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    level,
    plugin: 'slingshot-webhooks',
    message,
    ...fields,
    timestamp: new Date().toISOString(),
  });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
