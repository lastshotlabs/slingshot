import type { RunOptions } from './types';

/**
 * Minimal identity of the task or workflow being deduped.
 */
export interface IdempotencyTarget {
  type: 'task' | 'workflow';
  name: string;
}

function encodeScopePart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Build the portable adapter-level idempotency scope used to dedupe runs.
 *
 * Scoping by run type, definition name, and tenant prevents one workload or tenant
 * from replaying another workload's result when the caller reuses an idempotency key.
 */
export function createIdempotencyScope(
  target: IdempotencyTarget,
  options: Pick<RunOptions, 'idempotencyKey' | 'tenantId'>,
): string | undefined {
  if (!options.idempotencyKey) {
    return undefined;
  }

  return [
    'orch-idem',
    target.type,
    encodeScopePart(target.name),
    encodeScopePart(options.tenantId ?? 'global'),
    encodeScopePart(options.idempotencyKey),
  ].join(':');
}
