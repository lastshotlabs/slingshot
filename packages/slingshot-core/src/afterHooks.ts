import type { AuditLogEntry } from './auditLog';
import type { AfterHook, HandlerMeta } from './handler';

function pickPayload(
  output: Record<string, unknown>,
  fields: readonly string[] | undefined,
): Record<string, unknown> {
  if (!fields || fields.length === 0) {
    return { entity: output };
  }

  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    payload[field] = output[field];
  }
  return payload;
}

function includeMeta(
  payload: Record<string, unknown>,
  meta: HandlerMeta,
  include: readonly ('tenantId' | 'actorId' | 'requestId' | 'ip')[] | undefined,
): Record<string, unknown> {
  if (!include) return payload;

  if (include.includes('tenantId')) payload.tenantId = meta.tenantId;
  if (include.includes('actorId')) payload.actorId = meta.authUserId;
  if (include.includes('requestId')) payload.requestId = meta.requestId;
  if (include.includes('ip')) payload.ip = meta.ip;
  return payload;
}

/**
 * Emit a static event after a successful handler call.
 */
export function emitEvent(
  eventKey: string,
  opts?: {
    payload?: readonly string[];
    include?: readonly ('tenantId' | 'actorId' | 'requestId' | 'ip')[];
  },
): AfterHook {
  return async ({ ctx, meta, output }) => {
    const outputRecord =
      output && typeof output === 'object' ? (output as Record<string, unknown>) : { value: output };
    const payload = includeMeta(pickPayload(outputRecord, opts?.payload), meta, opts?.include);
    (ctx.bus as unknown as { emit(key: string, payload: unknown): void }).emit(eventKey, payload);
  };
}

/**
 * Emit a dynamically derived event after a successful handler call.
 */
export function emitEventDynamic(
  derive: (args: {
    input: unknown;
    output: unknown;
    meta: HandlerMeta;
  }) => { key: string; payload: Record<string, unknown> } | null,
): AfterHook {
  return async ({ input, output, ctx, meta }) => {
    const resolved = derive({ input, output, meta });
    if (!resolved) return;
    (ctx.bus as unknown as { emit(key: string, payload: unknown): void }).emit(
      resolved.key,
      resolved.payload,
    );
  };
}

/**
 * Write a simple audit entry after a successful handler call.
 */
export function auditLog(action: string): AfterHook {
  return async ({ ctx, meta, handlerName, input, output }) => {
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      userId: meta.authUserId,
      sessionId: null,
      tenantId: meta.tenantId,
      method: 'HANDLER',
      path: handlerName,
      status: 200,
      ip: meta.ip,
      userAgent: null,
      action,
      meta: { input, output },
      requestId: meta.requestId,
      createdAt: new Date().toISOString(),
    };
    await ctx.persistence.auditLog.logEntry(entry);
  };
}
