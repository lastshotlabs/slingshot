import { z } from 'zod';
import { defineTask } from '../../../packages/slingshot-orchestration/src/defineTask';
import {
  defineWorkflow,
  sleep,
  step,
} from '../../../packages/slingshot-orchestration/src/defineWorkflow';

const HOOK_LOG_KEY = '__slingshotTemporalHookLog';

interface HookLogEntry {
  hook: 'onStart' | 'onComplete' | 'onFail';
  runId: string;
  workflow: string;
}

function getHookLogStore(): HookLogEntry[] {
  const owner = globalThis as typeof globalThis & {
    [HOOK_LOG_KEY]?: HookLogEntry[];
  };
  owner[HOOK_LOG_KEY] ??= [];
  return owner[HOOK_LOG_KEY];
}

export function resetTemporalHookLog(): void {
  getHookLogStore().length = 0;
}

export function readTemporalHookLog(): HookLogEntry[] {
  return [...getHookLogStore()];
}

export const retryingEmailTaskExport = defineTask({
  name: 'retry-email',
  input: z.object({
    email: z.string().email(),
  }),
  output: z.object({
    email: z.string().email(),
    attempt: z.number().int().positive(),
  }),
  retry: {
    maxAttempts: 2,
    delayMs: 25,
    backoff: 'fixed',
  },
  timeout: 5_000,
  queue: 'email-activities',
  async handler(input, ctx) {
    ctx.reportProgress({
      percent: ctx.attempt === 1 ? 50 : 100,
      message: ctx.attempt === 1 ? 'retrying' : 'sent',
    });
    if (ctx.attempt === 1) {
      throw new Error('transient email failure');
    }
    return {
      email: input.email,
      attempt: ctx.attempt,
    };
  },
});

export const formatProfileTaskExport = defineTask({
  name: 'format-profile',
  input: z.object({
    firstName: z.string(),
    lastName: z.string(),
  }),
  output: z.object({
    fullName: z.string(),
  }),
  async handler(input) {
    return {
      fullName: `${input.firstName} ${input.lastName}`,
    };
  },
});

export const pauseTaskExport = defineTask({
  name: 'pause-task',
  input: z.object({
    label: z.string(),
  }),
  output: z.object({
    label: z.string(),
  }),
  async handler(input) {
    return input;
  },
});

const onboardingWorkflowInput = z.object({
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
});
type OnboardingWorkflowInput = z.infer<typeof onboardingWorkflowInput>;

export const onboardingWorkflowExport = defineWorkflow({
  name: 'onboard-user',
  input: onboardingWorkflowInput,
  output: z.object({
    emailAttempt: z.number().int().positive(),
    fullName: z.string(),
    pauseLabel: z.string(),
  }),
  steps: [
    step<OnboardingWorkflowInput>('retry-email-step', retryingEmailTaskExport, {
      input: ctx => ({
        email: ctx.workflowInput.email,
      }),
    }),
    sleep<OnboardingWorkflowInput>('workflow-pause', 100),
    step<OnboardingWorkflowInput>('format-profile-step', formatProfileTaskExport, {
      input: ctx => ({
        firstName: ctx.workflowInput.firstName,
        lastName: ctx.workflowInput.lastName,
      }),
    }),
    step<OnboardingWorkflowInput>('pause-step', pauseTaskExport, {
      input: () => ({
        label: 'resumed',
      }),
    }),
  ],
  outputMapper(results) {
    return {
      emailAttempt: (results['retry-email-step'] as { attempt: number }).attempt,
      fullName: (results['format-profile-step'] as { fullName: string }).fullName,
      pauseLabel: (results['pause-step'] as { label: string }).label,
    };
  },
  onStart(ctx) {
    getHookLogStore().push({
      hook: 'onStart',
      runId: ctx.runId,
      workflow: 'onboard-user',
    });
  },
  onComplete(ctx) {
    getHookLogStore().push({
      hook: 'onComplete',
      runId: ctx.runId,
      workflow: 'onboard-user',
    });
  },
  onFail(ctx) {
    getHookLogStore().push({
      hook: 'onFail',
      runId: ctx.runId,
      workflow: 'onboard-user',
    });
  },
});
