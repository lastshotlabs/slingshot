import type { RunStatus } from '@lastshotlabs/slingshot-orchestration';

export function mapTemporalStatus(statusName: string | undefined): RunStatus {
  switch (statusName) {
    case 'RUNNING':
      return 'running';
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
    case 'TIMED_OUT':
    case 'TERMINATED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'PAUSED':
    case 'CONTINUED_AS_NEW':
    case 'UNKNOWN':
    case 'UNSPECIFIED':
    default:
      return 'pending';
  }
}
