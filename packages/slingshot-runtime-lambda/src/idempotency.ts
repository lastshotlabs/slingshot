import {
  type HandlerMeta,
  type SlingshotContext,
  resolveActor,
  sha256,
} from '@lastshotlabs/slingshot-core';

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export interface RuntimeIdempotencyConfig {
  ttl?: number;
  scope?: 'global' | 'tenant' | 'user';
  fingerprint?: boolean;
  key?: (record: {
    body: unknown;
    meta: Record<string, unknown>;
    naturalKey?: string;
  }) => string | null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

function deriveKey(
  handlerName: string,
  rawKey: string,
  meta: HandlerMeta,
  scope: 'global' | 'tenant' | 'user',
): string {
  const actor = resolveActor(meta);
  const parts = ['functions-idempotency', handlerName];
  if (scope === 'tenant') {
    parts.push(`tenant:${meta.requestTenantId ?? 'none'}`);
  } else if (scope === 'user') {
    if (!actor.id) {
      throw new Error(`Idempotency scope 'user' requires an authenticated subject`);
    }
    parts.push(`tenant:${meta.requestTenantId ?? 'none'}`);
    parts.push(`subject:${actor.id}`);
  }
  parts.push(rawKey);
  return parts.join(':');
}

function serializeOutput(value: unknown): string {
  return JSON.stringify({ value });
}

function deserializeOutput<T>(payload: string): T {
  const parsed = JSON.parse(payload) as { value: T };
  return parsed.value;
}

export async function invokeWithRecordIdempotency<T>(
  ctx: SlingshotContext,
  handlerName: string,
  meta: HandlerMeta,
  record: { body: unknown; meta: Record<string, unknown>; naturalKey?: string },
  config: RuntimeIdempotencyConfig | undefined,
  invoke: () => Promise<T>,
): Promise<T> {
  const ttl = config?.ttl ?? 86400;
  const scope = config?.scope ?? 'global';
  const rawKey = config?.key
    ? config.key(record)
    : (record.naturalKey ?? meta.idempotencyKey ?? null);
  if (!rawKey) {
    return invoke();
  }

  const fingerprint = config?.fingerprint === false ? null : sha256(stableStringify(record.body));
  const key = deriveKey(handlerName, rawKey, meta, scope);

  // Idempotency store I/O failures should NOT crash the handler. If the store
  // is unreachable (e.g. transient Redis blip, DynamoDB throttle) we degrade
  // to non-idempotent execution rather than failing the whole invocation —
  // a duplicate replay is preferable to a hard 500 for an event that may
  // already have been processed by a sibling worker.
  let cached: Awaited<ReturnType<typeof ctx.persistence.idempotency.get>> | null = null;
  try {
    cached = await ctx.persistence.idempotency.get(key);
  } catch (err) {
    console.error('[lambda] idempotency.get failed; proceeding without replay:', err);
  }
  if (cached) {
    if (fingerprint && cached.requestFingerprint && cached.requestFingerprint !== fingerprint) {
      throw new IdempotencyConflictError('Idempotency key conflict');
    }
    return deserializeOutput<T>(cached.response);
  }

  const output = await invoke();
  try {
    await ctx.persistence.idempotency.set(key, serializeOutput(output), 200, ttl, {
      requestFingerprint: fingerprint ?? undefined,
    });
  } catch (err) {
    // Failing to persist the result means a future replay won't see it — same
    // outcome as if the store were unreachable on read. Log and continue; the
    // handler already produced its output.
    console.error('[lambda] idempotency.set failed; result will not be replay-cached:', err);
  }
  return output;
}
