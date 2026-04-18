import type { Context, Hono } from 'hono';
import type { AppEnv, SlingshotContext } from '@lastshotlabs/slingshot-core';
import { dispatchInteraction } from '../handlers/dispatch';
import type { InteractionsPluginState } from '../state';
import { dispatchRequestSchema } from './dispatchRoute.schema';

type DynamicBus = {
  emit(event: string, payload: unknown): void;
};

function readContextValue(c: Context, key: string): unknown {
  return (c as { get(name: string): unknown }).get(key);
}

/** Mount the interaction dispatch route at the configured mount path. */
export function buildDispatchRoute(
  app: Hono<AppEnv>,
  ctx: SlingshotContext,
  state: InteractionsPluginState,
  mountPath: string,
): void {
  const interactionEvents = state.repos.interactionEvents;
  if (interactionEvents === null) {
    throw new Error('[slingshot-interactions] InteractionEvent repository is not available');
  }

  app.post(`${mountPath}/dispatch`, async c => {
    const authUserId = readContextValue(c, 'authUserId');
    if (typeof authUserId !== 'string' || authUserId.length === 0) {
      return c.json({ error: 'unauthenticated' }, 401);
    }

    const tenantId = (readContextValue(c, 'tenantId') as string | undefined) ?? '';
    const raw: unknown = await c.req.json().catch(() => null);
    if (raw === null) {
      return c.json({ error: 'invalid json body' }, 400);
    }

    const parsed = dispatchRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid dispatch request', issues: parsed.error.issues }, 400);
    }

    const outcome = await dispatchInteraction(
      {
        ctx,
        handlers: state.handlers,
        evaluator: state.permissions.evaluator,
        rateLimit: state.rateLimit,
        peers: state.peers,
        rateLimitWindowMs: state.rateLimitWindowMs,
        rateLimitMax: state.rateLimitMax,
      },
      parsed.data,
      authUserId,
      tenantId,
    );

    try {
      await interactionEvents.create({
        tenantId,
        userId: authUserId,
        messageKind: parsed.data.messageKind,
        messageId: parsed.data.messageId,
        actionId: parsed.data.actionId,
        actionIdPrefix: parsed.data.actionId.includes(':')
          ? parsed.data.actionId.slice(0, parsed.data.actionId.indexOf(':'))
          : parsed.data.actionId,
        handlerKind: outcome.handlerKind,
        responseStatus: outcome.status,
        latencyMs: outcome.latencyMs,
        errorDetail: outcome.errorDetail,
      });
    } catch (error) {
      state.logger?.warn?.(
        { err: error, plugin: 'slingshot-interactions' },
        'failed to write InteractionEvent audit row',
      );
    }

    const dynamicBus = state.bus as DynamicBus;
    dynamicBus.emit(
      outcome.status === 'ok' ? 'interactions:event.dispatched' : 'interactions:event.failed',
      {
        userId: authUserId,
        tenantId,
        messageKind: parsed.data.messageKind,
        messageId: parsed.data.messageId,
        actionId: parsed.data.actionId,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
      },
    );

    return c.json(
      outcome.body,
      outcome.httpStatus as 200 | 400 | 401 | 403 | 404 | 429 | 502 | 503 | 504,
    );
  });
}
