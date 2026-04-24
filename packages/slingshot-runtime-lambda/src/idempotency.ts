import {
  type HandlerMeta,
  type SlingshotContext,
  resolveActor,
  sha256,
} from '@lastshotlabs/slingshot-core';

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
    parts.push(`tenant:${meta.requestTenantId ?? actor.tenantId ?? 'none'}`);
  } else if (scope === 'user') {
    if (!actor.id) {
      throw new Error(`Idempotency scope 'user' requires an authenticated subject`);
    }
    parts.push(`tenant:${meta.requestTenantId ?? actor.tenantId ?? 'none'}`);
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
  const cached = await ctx.persistence.idempotency.get(key);
  if (cached) {
    if (fingerprint && cached.requestFingerprint && cached.requestFingerprint !== fingerprint) {
      throw new Error('Idempotency key conflict');
    }
    return deserializeOutput<T>(cached.response);
  }

  const output = await invoke();
  await ctx.persistence.idempotency.set(key, serializeOutput(output), 200, ttl, {
    requestFingerprint: fingerprint ?? undefined,
  });
  return output;
}
