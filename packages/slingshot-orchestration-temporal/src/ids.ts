import { createHash } from 'node:crypto';
import { generateRunId } from '@lastshotlabs/slingshot-orchestration';

/**
 * Derive the Temporal workflow ID used for a portable run.
 *
 * When an idempotency key is present the result is deterministic across retries for the
 * same task/workflow name and tenant. Without one, a fresh public run ID is generated.
 */
export function deriveTemporalRunId(options: {
  kind: 'task' | 'workflow';
  name: string;
  tenantId?: string;
  idempotencyKey?: string;
}): string {
  if (!options.idempotencyKey) {
    return generateRunId();
  }

  const digest = createHash('sha256')
    .update(options.kind)
    .update('\0')
    .update(options.name)
    .update('\0')
    .update(options.tenantId ?? '')
    .update('\0')
    .update(options.idempotencyKey)
    .digest('hex')
    .slice(0, 48);

  return `run_${digest}`;
}
