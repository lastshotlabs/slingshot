import type { JobState } from 'bullmq';
import type { RunStatus } from '@lastshotlabs/slingshot-orchestration';

/**
 * Map BullMQ job states onto the portable orchestration run status enum.
 */
export function mapBullMQStatus(state: JobState | 'paused' | 'unknown'): RunStatus {
  switch (state) {
    case 'active':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'waiting':
    case 'waiting-children':
    case 'delayed':
    case 'prioritized':
    case 'paused':
      return 'pending';
    default:
      return 'pending';
  }
}
