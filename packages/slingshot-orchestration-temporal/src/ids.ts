import { createHash } from 'node:crypto';
import { generateRunId } from '@lastshotlabs/slingshot-orchestration';

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
