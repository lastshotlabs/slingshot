import {
  type HandlerMeta,
  type Logger,
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

/**
 * Outcome of an `onIdempotencyConflict` callback.
 *
 * - `'reject'` — current/default behaviour: throw `IdempotencyConflictError`,
 *   which is classified as `'idempotency'` by the invocation loop and routed
 *   through `onError` like any other failure.
 * - `'replay'` — return the previously cached response as the result of this
 *   call (the second caller observes the first caller's output).
 * - `'accept'` — treat the request as new: skip the cached entry, run the
 *   handler again, and overwrite the stored response with the new one.
 */
export type IdempotencyConflictResolution = 'reject' | 'replay' | 'accept';

export interface IdempotencyConflictInfo {
  /** Idempotency key that triggered the conflict. */
  key: string;
  /** Stored fingerprint at the time of conflict (`null` if fingerprint was disabled originally). */
  storedFingerprint: string | null;
  /** Fingerprint of the current request. */
  incomingFingerprint: string;
  /** Handler name (for logging / routing). */
  handlerName: string;
  /** Meta surrounding the current invocation. */
  meta: HandlerMeta;
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
  /**
   * P-LAMBDA-4: hook invoked when the incoming request fingerprint does not
   * match the previously stored fingerprint. Return `'reject'` (default,
   * preserves the prior throw-on-mismatch behaviour), `'replay'` (return the
   * cached response anyway), or `'accept'` (overwrite the cached entry with
   * the new result).
   *
   * Synchronous or async; either is fine. Throws are caught and treated as
   * `'reject'` so a buggy hook never bypasses the safety check.
   */
  onIdempotencyConflict?: (
    info: IdempotencyConflictInfo,
  ) => IdempotencyConflictResolution | Promise<IdempotencyConflictResolution>;
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
  logger?: Logger,
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
    if (logger) logger.error('idempotency.get failed; proceeding without replay', { err: String(err) });
  }
  if (cached) {
    if (fingerprint && cached.requestFingerprint && cached.requestFingerprint !== fingerprint) {
      // P-LAMBDA-4: defer to caller-supplied hook. Default is the original
      // throw-on-mismatch behaviour. The hook may also opt to replay the
      // cached response or accept the new request as authoritative.
      let resolution: IdempotencyConflictResolution = 'reject';
      if (config?.onIdempotencyConflict) {
        try {
          resolution = await Promise.resolve(
            config.onIdempotencyConflict({
              key,
              storedFingerprint: cached.requestFingerprint,
              incomingFingerprint: fingerprint,
              handlerName,
              meta,
            }),
          );
        } catch (err) {
          // Buggy hook must NOT bypass the safety check — fall back to reject.
          if (logger) logger.error('onIdempotencyConflict hook threw; falling back to reject', { err: String(err) });
          resolution = 'reject';
        }
      }
      if (resolution === 'replay') {
        return deserializeOutput<T>(cached.response);
      }
      if (resolution === 'reject') {
        throw new IdempotencyConflictError('Idempotency key conflict');
      }
      // resolution === 'accept' — fall through to running the handler and
      // overwriting the cached entry.
    } else {
      return deserializeOutput<T>(cached.response);
    }
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
    if (logger) logger.error('idempotency.set failed; result will not be replay-cached', { err: String(err) });
  }
  return output;
}
