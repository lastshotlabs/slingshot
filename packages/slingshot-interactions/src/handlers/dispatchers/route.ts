import type { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { dispatchResultSchema } from '../../routes/dispatchRoute.schema';
import type { Dispatcher } from '../contracts';
import type { RouteHandlerTemplate } from '../template';

export function createRouteDispatcher(
  template: RouteHandlerTemplate,
  app: Hono<AppEnv>,
): Dispatcher {
  return {
    async dispatch(payload) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), template.timeoutMs);

      try {
        const response = await app.request(
          new Request(`http://slingshot.local${template.target}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          }),
        );

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
