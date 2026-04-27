import { supportsCapability, throwUnsupported } from './adapter';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  ObservabilityCapability,
  OrchestrationRuntime,
  OrchestrationRuntimeOptions,
  ProgressCapability,
  ScheduleCapability,
  SignalCapability,
} from './types';

/**
 * Build the portable orchestration runtime from a concrete adapter plus registered
 * task and workflow definitions.
 *
 * This composition root is intentionally framework-agnostic. It can run in plain
 * scripts, tests, workers, or inside the Slingshot plugin wrapper.
 */
export function createOrchestrationRuntime(
  options: OrchestrationRuntimeOptions,
): OrchestrationRuntime {
  const workflows = options.workflows ?? [];
  for (const task of options.tasks) {
    options.adapter.registerTask(task);
  }
  for (const workflow of workflows) {
    options.adapter.registerWorkflow(workflow);
  }

  async function runTask(taskOrName: string | AnyResolvedTask, input: unknown, opts?: unknown) {
    const taskName = typeof taskOrName === 'string' ? taskOrName : taskOrName.name;
    return options.adapter.runTask(taskName, input, opts as never);
  }

  async function runWorkflow(
    workflowOrName: string | AnyResolvedWorkflow,
    input: unknown,
    opts?: unknown,
  ) {
    const workflowName = typeof workflowOrName === 'string' ? workflowOrName : workflowOrName.name;
    return options.adapter.runWorkflow(workflowName, input, opts as never);
  }

  return {
    runTask,
    runWorkflow,
    getRun(runId) {
      return options.adapter.getRun(runId);
    },
    cancelRun(runId) {
      return options.adapter.cancelRun(runId);
    },
    supports(capability) {
      return supportsCapability(options.adapter, capability);
    },
    /**
     * Send a signal to an in-flight workflow run.
     *
     * @not-implemented Signals are not yet supported by the memory or SQLite adapters.
     * Use slingshot-orchestration-temporal for signal support.
     * Check `runtime.supports('signals')` before calling.
     */
    signal(runId, name, payload) {
      if (!supportsCapability(options.adapter, 'signals')) {
        return Promise.reject(throwUnsupported('signals'));
      }
      return (options.adapter as SignalCapability).signal(runId, name, payload);
    },
    /**
     * Schedule a task or workflow to run on a cron expression.
     *
     * @not-implemented Scheduling is not yet supported by the memory or SQLite adapters.
     * Use slingshot-orchestration-temporal for scheduling support.
     * Check `runtime.supports('scheduling')` before calling.
     */
    schedule(target, cron, input) {
      if (!supportsCapability(options.adapter, 'scheduling')) {
        return Promise.reject(throwUnsupported('scheduling'));
      }
      return (options.adapter as ScheduleCapability).schedule(target, cron, input);
    },
    /**
     * @not-implemented Scheduling is not yet supported by the memory or SQLite adapters.
     * Use slingshot-orchestration-temporal for scheduling support.
     */
    unschedule(scheduleId) {
      if (!supportsCapability(options.adapter, 'scheduling')) {
        return Promise.reject(throwUnsupported('scheduling'));
      }
      return (options.adapter as ScheduleCapability).unschedule(scheduleId);
    },
    /**
     * @not-implemented Scheduling is not yet supported by the memory or SQLite adapters.
     * Use slingshot-orchestration-temporal for scheduling support.
     */
    listSchedules() {
      if (!supportsCapability(options.adapter, 'scheduling')) {
        return Promise.reject(throwUnsupported('scheduling'));
      }
      return (options.adapter as ScheduleCapability).listSchedules();
    },
    listRuns(filter) {
      if (!supportsCapability(options.adapter, 'observability')) {
        return Promise.reject(throwUnsupported('observability'));
      }
      return (options.adapter as ObservabilityCapability).listRuns(filter);
    },
    onProgress(runId, callback) {
      if (!supportsCapability(options.adapter, 'progress')) {
        return throwUnsupported('progress');
      }
      return (options.adapter as ProgressCapability).onProgress(runId, callback);
    },
  };
}
