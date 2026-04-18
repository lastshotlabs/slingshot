import { createHmac } from 'node:crypto';
import { dispatchResultSchema } from '../../routes/dispatchRoute.schema';
import type { Dispatcher } from '../contracts';
import type { WebhookHandlerTemplate } from '../template';

export function createWebhookDispatcher(template: WebhookHandlerTemplate): Dispatcher {
  return {
    async dispatch(payload) {
      const bodyText = JSON.stringify(payload);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(template.headers ?? {}),
      };

      if (template.signingSecret) {
        const mac = createHmac('sha256', template.signingSecret);
        mac.update(bodyText);
        headers['X-Slingshot-Signature'] = mac.digest('hex');
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
