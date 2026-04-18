import type { Hono } from 'hono';
import type { AppEnv, SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { CompiledHandlerTable } from './contracts';
import { createQueueDispatcher } from './dispatchers/queue';
import { createRouteDispatcher } from './dispatchers/route';
import { createWebhookDispatcher } from './dispatchers/webhook';
import type { HandlerTemplate } from './template';

function matchesPrefix(actionId: string, prefix: string): boolean {
  return actionId === prefix || actionId.startsWith(prefix);
}

/**
 * Compile declarative handler templates into runtime dispatchers.
 *
 * @param handlers - Declarative handler table keyed by action-id prefix.
 * @param deps - Shared runtime dependencies needed by handler kinds.
 * @returns A lookup table that resolves the longest matching prefix first.
 */
export function compileHandlers(
  handlers: Record<string, HandlerTemplate>,
  deps: { app: Hono<AppEnv>; bus: SlingshotEventBus },
): CompiledHandlerTable {
  const entries = Object.entries(handlers).map(([prefix, template]) => {
    const dispatcher =
      template.kind === 'webhook'
        ? createWebhookDispatcher(template)
        : template.kind === 'route'
          ? createRouteDispatcher(template, deps.app)
          : createQueueDispatcher(template, deps.bus);

    return [prefix, { prefix, template, dispatcher }] as const;
  });

  const byPrefix = Object.freeze(Object.fromEntries(entries));
  const sortedKeys = Object.freeze([...Object.keys(byPrefix)].sort((a, b) => b.length - a.length));

  return {
    byPrefix,
    sortedKeys,
    resolve(actionId: string) {
      for (const prefix of sortedKeys) {
        if (matchesPrefix(actionId, prefix)) {
          return byPrefix[prefix] ?? null;
        }
      }

      return null;
    },
  };
}
