// ---------------------------------------------------------------------------
// Scheduling: cron-based repeatable job management for the BullMQ
// orchestration adapter.
// ---------------------------------------------------------------------------
import type { Queue } from 'bullmq';
import type { ScheduleHandle } from '@lastshotlabs/slingshot-orchestration';
import { generateRunId } from '@lastshotlabs/slingshot-orchestration';
import type { AnyResolvedTask } from '@lastshotlabs/slingshot-orchestration';

// ---------------------------------------------------------------------------
// Scheduling state
// ---------------------------------------------------------------------------

export interface SchedulingState {
  defaultTaskQueue: Queue;
  workflowQueue: Queue;
  namedQueues: Map<string, Queue>;
  workflowQueueName: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSchedulingFns(
  state: SchedulingState,
  ensureStarted: () => Promise<void>,
  resolveTask: (name: string) => AnyResolvedTask,
  getQueueForTaskName: (name: string) => Queue,
) {
  async function schedule(
    target: { type: 'task' | 'workflow'; name: string },
    cron: string,
    input: unknown,
  ): Promise<{
    id: string;
    target: { type: 'task' | 'workflow'; name: string };
    cron: string;
    input: unknown;
  }> {
    await ensureStarted();
    const queue = target.type === 'task' ? getQueueForTaskName(target.name) : state.workflowQueue;
    const scheduleId = `slingshot-schedule-${target.type}-${target.name}-${generateRunId()}`;
    await queue.add(
      target.name,
      {
        [target.type === 'task' ? 'taskName' : 'workflowName']: target.name,
        input,
        _scheduled: true,
      },
      {
        jobId: scheduleId,
        repeat: { pattern: cron },
      },
    );
    return { id: scheduleId, target, cron, input };
  }

  async function unschedule(scheduleId: string): Promise<void> {
    await ensureStarted();
    for (const queue of [
      state.defaultTaskQueue,
      state.workflowQueue,
      ...state.namedQueues.values(),
    ]) {
      const jobSchedulers = await queue.getJobSchedulers(0, 999);
      for (const scheduler of jobSchedulers) {
        if (scheduler.key === scheduleId) {
          await queue.removeJobScheduler(scheduler.key);
          return;
        }
      }
    }
  }

  async function listSchedules(): Promise<ScheduleHandle[]> {
    await ensureStarted();
    const schedules: ScheduleHandle[] = [];
    for (const queue of [
      state.defaultTaskQueue,
      state.workflowQueue,
      ...state.namedQueues.values(),
    ]) {
      const jobSchedulers = await queue.getJobSchedulers(0, 999);
      for (const scheduler of jobSchedulers) {
        schedules.push({
          id: scheduler.key,
          target: {
            type: queue.name === state.workflowQueueName ? 'workflow' : 'task',
            name: scheduler.name,
          },
          cron: scheduler.pattern ?? '',
        });
      }
    }
    return schedules;
  }

  return { schedule, unschedule, listSchedules };
}
