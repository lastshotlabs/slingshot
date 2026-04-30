import { createHmac, timingSafeEqual } from 'node:crypto';
import { dispatchResultSchema } from '../../routes/dispatchRoute.schema';
import type { Dispatcher } from '../contracts';
import type { WebhookHandlerTemplate } from '../template';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Verify a webhook signature and timestamp to prevent replay attacks.
 * @returns `true` if the signature is valid and the timestamp is within tolerance.
 */
export function verifyWebhookSignature(
  body: string,
  signature: string,
  timestamp: string,
  secret: string,
  toleranceMs = TIMESTAMP_TOLERANCE_MS,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > toleranceMs) return false;

  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.${body}`);
  const expected = mac.digest('hex');

  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function createWebhookDispatcher(template: WebhookHandlerTemplate): Dispatcher {
  return {
    async dispatch(payload) {
      const bodyText = JSON.stringify(payload);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(template.headers ?? {}),
      };

      if (template.signingSecret) {
        const timestamp = Date.now().toString();
        const mac = createHmac('sha256', template.signingSecret);
        mac.update(`${timestamp}.${bodyText}`);
        headers['X-Slingshot-Signature'] = mac.digest('hex');
        headers['X-Slingshot-Timestamp'] = timestamp;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), template.timeoutMs);

      try {
        const response = await fetch(template.target, {
          method: 'POST',
          headers,
          body: bodyText,
          signal: controller.signal,
        });

        if (response.status < 200 || response.status >= 300) {
          throw new Error(`non-2xx: ${response.status}`);
        }

        const json: unknown = await response.json().catch(() => ({ status: 'ok' }));
        return dispatchResultSchema.parse(json);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('timeout', { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
