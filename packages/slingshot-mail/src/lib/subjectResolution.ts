/**
 * Resolves the final email subject by priority: subscription-level override → renderer subject → fallback.
 *
 * @param subscriptionSubject - Subject from `MailSubscription.subject`, if set.
 * @param rendererSubject - Subject returned by the renderer's `render()` call, if set.
 * @param fallback - Subject to use when neither of the above is present. Defaults to `'(no subject)'`.
 * @returns The resolved subject string.
 */
export function resolveSubject(
  subscriptionSubject: string | undefined,
  rendererSubject: string | undefined,
  fallback = '(no subject)',
): string {
  return subscriptionSubject ?? rendererSubject ?? fallback;
}

function interpolateSubject(subject: string, data: Record<string, unknown>): string {
  return subject.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = data[key as string];
    if (value == null) return '';
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint' ||
      value instanceof Date
    ) {
      return String(value);
    }
    if (typeof value === 'symbol' || typeof value === 'function') {
      return '';
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  });
}

/**
 * Resolves and interpolates `{{variable}}` placeholders into the final email subject.
 *
 * Combines `resolveSubject` with inline `{{key}}` interpolation using the template data bag.
 *
 * @param subscriptionSubject - Subject from `MailSubscription.subject`, if set.
 * @param rendererSubject - Subject returned by the renderer's `render()` call, if set.
 * @param data - Key-value data bag used to replace `{{key}}` placeholders.
 * @param fallback - Subject to use when no subject is found. Defaults to `'(no subject)'`.
 * @returns The resolved and interpolated subject string.
 */
export function resolveAndInterpolateSubject(
  subscriptionSubject: string | undefined,
  rendererSubject: string | undefined,
  data: Record<string, unknown>,
  fallback = '(no subject)',
): string {
  const subject = resolveSubject(subscriptionSubject, rendererSubject, fallback);
  return interpolateSubject(subject, data);
}
