import { getAuthenticatedAccountGuardFailure } from '@framework/lib/authRouteGuard';
import { EVENT_RELIABILITY_OPERATIONS_KEY } from '@framework/persistence/events/reliabilityOperations';
import type { Context, Next } from 'hono';
import {
  createRouter,
  getActor,
  getClientIp,
  getPermissionsStateOrNull,
  getRequestTenantId,
  getRouteAuth,
  getSlingshotCtx,
} from '@lastshotlabs/slingshot-core';
import type { AppEnv, AuditLogEntry } from '@lastshotlabs/slingshot-core';
import type { EventReliabilityOperations, OutboxStatus } from '@lastshotlabs/slingshot-events';
import type { EventOperatorConfig } from '../../config/types/events';

const EVENT_OPERATIONS_RESOURCE = 'event-operations';
const MAX_LIMIT = 1000;
const MAX_REASON_LENGTH = 500;

type EventPermission = 'events:read' | 'events:operate';

function operations(c: Context<AppEnv>): EventReliabilityOperations {
  const value = getSlingshotCtx(c).pluginState.get(EVENT_RELIABILITY_OPERATIONS_KEY.name);
  if (!value) throw new Error('[events] reliability operations are unavailable');
  return value as EventReliabilityOperations;
}

function positiveLimit(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_LIMIT ? parsed : null;
}

function boundedReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length > 0 && reason.length <= MAX_REASON_LENGTH ? reason : null;
}

function authenticatedActorId(c: Context<AppEnv>): string {
  const actorId = getActor(c).id;
  if (!actorId) throw new Error('[events] authenticated operator actor is unavailable');
  return actorId;
}

async function writeAudit(
  c: Context<AppEnv>,
  input: {
    action: string;
    status: number;
    resourceId?: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  const ctx = getSlingshotCtx(c);
  const actor = getActor(c);
  const entry: AuditLogEntry = {
    id: crypto.randomUUID(),
    userId: actor.id,
    sessionId: actor.sessionId,
    requestTenantId: getRequestTenantId(c),
    method: c.req.method,
    path: c.req.path,
    status: input.status,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
    action: input.action,
    resource: EVENT_OPERATIONS_RESOURCE,
    resourceId: input.resourceId,
    meta: input.meta,
    requestId: c.get('requestId'),
    createdAt: new Date().toISOString(),
  };
  await ctx.persistence.auditLog.logEntry(entry);
}

async function requirePermission(
  c: Context<AppEnv>,
  permission: EventPermission,
): Promise<Response | null> {
  const actor = getActor(c);
  if (!actor.id || actor.kind !== 'user') {
    await writeAudit(c, { action: permission, status: 401, meta: { allowed: false } });
    return c.json({ error: 'Authentication required' }, 401);
  }
  const permissions = getPermissionsStateOrNull(getSlingshotCtx(c));
  if (!permissions) {
    await writeAudit(c, { action: permission, status: 503, meta: { allowed: false } });
    return c.json({ error: 'Permissions unavailable' }, 503);
  }
  const allowed = await permissions.evaluator.can(
    { subjectId: actor.id, subjectType: 'user' },
    permission,
    {
      tenantId: getRequestTenantId(c),
      resourceType: EVENT_OPERATIONS_RESOURCE,
      resourceId: null,
    },
  );
  if (!allowed) {
    await writeAudit(c, { action: permission, status: 403, meta: { allowed: false } });
    return c.json({ error: 'Forbidden' }, 403);
  }
  return null;
}

async function parseMutation(
  c: Context<AppEnv>,
): Promise<{ readonly reason: string; readonly limit: number } | { readonly response: Response }> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    return { response: c.json({ error: 'A JSON body is required' }, 400) };
  }
  if (!value || typeof value !== 'object') {
    return { response: c.json({ error: 'A JSON object is required' }, 400) };
  }
  const record = value as Record<string, unknown>;
  const reason = boundedReason(record.reason);
  if (!reason) {
    return {
      response: c.json({ error: `reason must contain 1-${MAX_REASON_LENGTH} characters` }, 400),
    };
  }
  const limit = record.limit === undefined ? 100 : positiveLimit(String(record.limit), Number.NaN);
  if (limit === null || Number.isNaN(limit)) {
    return { response: c.json({ error: `limit must be an integer from 1-${MAX_LIMIT}` }, 400) };
  }
  return { reason, limit };
}

/** Create the authenticated, permission-checked event reliability operator router. */
export function createEventOperationsRouter(config: EventOperatorConfig) {
  const router = createRouter();
  const base = (config.path ?? '/admin/events').replace(/\/+$/, '');

  const authenticate = (c: Context<AppEnv>, next: Next) =>
    getRouteAuth(getSlingshotCtx(c)).userAuth(c, next);
  router.use(base, authenticate);
  router.use(`${base}/*`, authenticate);
  router.use(base, async (c, next) => {
    const failure = await getAuthenticatedAccountGuardFailure(c);
    if (failure) return c.json({ error: failure.error }, failure.status);
    await next();
  });
  router.use(`${base}/*`, async (c, next) => {
    const failure = await getAuthenticatedAccountGuardFailure(c);
    if (failure) return c.json({ error: failure.error }, failure.status);
    await next();
  });

  router.get(`${base}/outbox/status`, async c => {
    const denied = await requirePermission(c, 'events:read');
    if (denied) return denied;
    return c.json(await operations(c).status(new Date().toISOString()));
  });

  router.get(`${base}/outbox`, async c => {
    const denied = await requirePermission(c, 'events:read');
    if (denied) return denied;
    const status = c.req.query('status') ?? 'dead';
    if (!['pending', 'leased', 'delivered', 'dead'].includes(status)) {
      return c.json({ error: 'Invalid outbox status' }, 400);
    }
    const limit = positiveLimit(c.req.query('limit'), 100);
    if (limit === null)
      return c.json({ error: `limit must be an integer from 1-${MAX_LIMIT}` }, 400);
    return c.json({ items: await operations(c).list(status as OutboxStatus, limit) });
  });

  router.get(`${base}/outbox/:eventId`, async c => {
    const denied = await requirePermission(c, 'events:read');
    if (denied) return denied;
    const detail = await operations(c).inspect(c.req.param('eventId'));
    return detail ? c.json(detail) : c.json({ error: 'Event not found' }, 404);
  });

  router.get(`${base}/replay-audit`, async c => {
    const denied = await requirePermission(c, 'events:read');
    if (denied) return denied;
    const limit = positiveLimit(c.req.query('limit'), 100);
    if (limit === null)
      return c.json({ error: `limit must be an integer from 1-${MAX_LIMIT}` }, 400);
    return c.json({ items: await operations(c).listReplayAudit(limit) });
  });

  router.post(`${base}/outbox/:eventId/retry`, async c => {
    const denied = await requirePermission(c, 'events:operate');
    if (denied) return denied;
    const mutation = await parseMutation(c);
    if ('response' in mutation) return mutation.response;
    const eventId = c.req.param('eventId');
    const detail = await operations(c).inspect(eventId);
    if (!detail || detail.status !== 'dead') return c.json({ error: 'Dead event not found' }, 404);
    const validation = await operations(c).validateReplay(eventId);
    if (!validation.compatible) {
      await writeAudit(c, {
        action: 'events.retry',
        status: 409,
        resourceId: eventId,
        meta: { allowed: false, reason: validation.reason },
      });
      return c.json({ error: 'Replay incompatible', reason: validation.reason }, 409);
    }
    const retried = await operations(c).retryEvent({
      eventId,
      expectedVersion: detail.attempts,
      now: new Date().toISOString(),
      actor: authenticatedActorId(c),
      reason: mutation.reason,
    });
    const status = retried ? 200 : 409;
    await writeAudit(c, {
      action: 'events.retry',
      status,
      resourceId: eventId,
      meta: { allowed: true, reason: mutation.reason, retried },
    });
    return retried
      ? c.json({ retried: true })
      : c.json({ error: 'Event changed before retry' }, 409);
  });

  router.post(`${base}/outbox/retry-dead`, async c => {
    const denied = await requirePermission(c, 'events:operate');
    if (denied) return denied;
    const mutation = await parseMutation(c);
    if ('response' in mutation) return mutation.response;
    const dead = await operations(c).list('dead', mutation.limit);
    let retried = 0;
    const deniedEventIds: string[] = [];
    for (const row of dead) {
      const validation = await operations(c).validateReplay(row.eventId);
      if (!validation.compatible) {
        deniedEventIds.push(row.eventId);
        continue;
      }
      if (
        await operations(c).retryEvent({
          eventId: row.eventId,
          expectedVersion: row.attempts,
          now: new Date().toISOString(),
          actor: authenticatedActorId(c),
          reason: mutation.reason,
        })
      ) {
        retried += 1;
      }
    }
    await writeAudit(c, {
      action: 'events.retry-dead',
      status: 200,
      meta: { allowed: true, reason: mutation.reason, retried, deniedEventIds },
    });
    return c.json({ retried, deniedEventIds });
  });

  router.delete(`${base}/outbox/delivered`, async c => {
    const denied = await requirePermission(c, 'events:operate');
    if (denied) return denied;
    const mutation = await parseMutation(c);
    if ('response' in mutation) return mutation.response;
    const before = c.req.query('before');
    if (!before || Number.isNaN(Date.parse(before))) {
      return c.json({ error: 'before must be an ISO timestamp' }, 400);
    }
    const purged = await operations(c).purgeDelivered({
      before,
      limit: mutation.limit,
      now: new Date().toISOString(),
      actor: authenticatedActorId(c),
      reason: mutation.reason,
    });
    await writeAudit(c, {
      action: 'events.purge-delivered',
      status: 200,
      meta: { allowed: true, reason: mutation.reason, before, purged },
    });
    return c.json({ purged });
  });

  router.delete(`${base}/inbox`, async c => {
    const denied = await requirePermission(c, 'events:operate');
    if (denied) return denied;
    const mutation = await parseMutation(c);
    if ('response' in mutation) return mutation.response;
    const before = c.req.query('before');
    if (!before || Number.isNaN(Date.parse(before))) {
      return c.json({ error: 'before must be an ISO timestamp' }, 400);
    }
    const purged = await operations(c).purgeInbox({
      before,
      limit: mutation.limit,
      now: new Date().toISOString(),
      actor: authenticatedActorId(c),
      reason: mutation.reason,
    });
    await writeAudit(c, {
      action: 'events.purge-inbox',
      status: 200,
      meta: { allowed: true, reason: mutation.reason, before, purged },
    });
    return c.json({ purged });
  });

  return router;
}

/** Register the event operator permission vocabulary after package setup. */
export function registerEventOperatorPermissions(c: {
  readonly pluginState: Parameters<typeof getPermissionsStateOrNull>[0];
}): boolean {
  const permissions = getPermissionsStateOrNull(c.pluginState);
  if (!permissions) return false;
  if (!permissions.registry.getDefinition(EVENT_OPERATIONS_RESOURCE)) {
    permissions.registry.register({
      resourceType: EVENT_OPERATIONS_RESOURCE,
      actions: ['events:read', 'events:operate'],
      roles: {
        viewer: ['events:read'],
        operator: ['events:read', 'events:operate'],
      },
    });
  }
  return true;
}
