/** Immutable, versioned tenant identity envelope safe for asynchronous transport. */
export interface TenantExecutionContextSnapshot {
  readonly version: 1;
  readonly tenantId: string;
  readonly actorId: string | null;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly idempotencyKey: string | null;
}

/** Request or worker identity fields accepted when capturing a tenant snapshot. */
export interface TenantExecutionContextInput {
  readonly tenantId: string | null | undefined;
  readonly actorId?: string | null;
  readonly requestId?: string | null;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  readonly idempotencyKey?: string | null;
}

/** Capture immutable identity for transport across an asynchronous boundary. */
export function captureTenantExecutionContext(
  input: TenantExecutionContextInput,
): TenantExecutionContextSnapshot {
  const tenantId = input.tenantId?.trim();
  if (!tenantId) throw new Error('Tenant execution context requires a tenantId.');
  return Object.freeze({
    version: 1,
    tenantId,
    actorId: input.actorId ?? null,
    requestId: input.requestId ?? null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  });
}

/** Parse and validate a serialized tenant execution context envelope. */
export function deserializeTenantExecutionContext(value: unknown): TenantExecutionContextSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('Malformed tenant execution context.');
  }
  const input = value as Partial<TenantExecutionContextSnapshot>;
  if (input.version !== 1) throw new Error('Unsupported tenant execution context version.');
  return captureTenantExecutionContext(input as TenantExecutionContextInput);
}

/** Restore identity for exactly one callback without module-global mutation. */
export async function withTenantExecutionContext<T>(
  snapshot: TenantExecutionContextSnapshot,
  callback: (context: TenantExecutionContextSnapshot) => T | Promise<T>,
): Promise<T> {
  const restored = deserializeTenantExecutionContext(snapshot);
  return callback(restored);
}
