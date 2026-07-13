/**
 * `@lastshotlabs/slingshot-ai/orchestration`
 *
 * A SEPARATE entry point, deliberately. Importing `@lastshotlabs/slingshot-ai`
 * must never pull in the orchestration engine — most apps generate inline and
 * should not pay for a queue they don't have.
 *
 * ## The constraint that shapes everything here
 *
 * **A zod schema cannot be put on a queue.** It is a live object with methods
 * and closures; `JSON.stringify` turns it into `{}`. So a durable background
 * generation cannot carry the caller's schema with it.
 *
 * The way through is a registry: the app names the schemas its background jobs
 * may produce, the queued job carries only the NAME, and the worker looks the
 * real schema up on the other side. That also means a job can never be enqueued
 * for a schema the worker wouldn't recognize — `supports()` is checked before
 * enqueueing, and an unregistered schema falls back to an inline run with a
 * warning rather than becoming a job that is guaranteed to fail on pickup.
 *
 * ## Wiring
 *
 * ```ts
 * import { createAiGenerationTask } from '@lastshotlabs/slingshot-ai/orchestration';
 *
 * const aiTask = createAiGenerationTask({ schemas: { deck: DeckSchema } });
 *
 * export default defineApp({
 *   packages: [
 *     createAiPackage({ ...,  orchestration: { enabled: true } }),
 *     createOrchestrationPackage({ adapter, tasks: [aiTask] }),
 *   ],
 * });
 * ```
 *
 * With that in place, `generateStructuredInBackground({ schema: DeckSchema,
 * schemaName: 'deck', ... })` returns `{ mode: 'queued', runId }`. Without it,
 * the same call returns `{ mode: 'sync', result }` — correct, just not durable,
 * and the discriminated union makes it impossible to confuse the two.
 */
import { z } from 'zod';
import { defineTask } from '@lastshotlabs/slingshot-orchestration-engine';
import type { ResolvedTask } from '@lastshotlabs/slingshot-orchestration-engine';
import { AiConfigError } from './errors';
import { registerBackgroundSchemas } from './lib/backgroundRegistry';
import { AiClientCap } from './public';
import type { AiEffort, AiMessage } from './types';

/** The default task name. Kebab-case, as the engine requires. */
export const AI_GENERATION_TASK_NAME = 'slingshot-ai-generate-structured';

/**
 * What actually rides the queue. Everything here survives `JSON.stringify` —
 * which is precisely why `schema` is absent and `schemaName` is present.
 */
const taskInputSchema = z.object({
  schemaName: z.string(),
  request: z.object({
    system: z.unknown().optional(),
    messages: z.array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    ),
    provider: z.string().optional(),
    model: z.string().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    maxTokens: z.number().int().positive().optional(),
    thinking: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    promptCacheKey: z.string().optional(),
    tags: z.record(z.string(), z.string()).optional(),
  }),
});

const taskOutputSchema = z.object({
  /** The validated object, as produced by the app's real zod schema. */
  value: z.unknown(),
  provider: z.string(),
  model: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    /** `null` = unpriced. Not zero. The distinction survives the queue too. */
    costUsd: z.number().nullable(),
  }),
});

export type AiGenerationTaskInput = z.infer<typeof taskInputSchema>;
export type AiGenerationTaskOutput = z.infer<typeof taskOutputSchema>;

export interface CreateAiGenerationTaskOptions {
  /**
   * The schemas a background generation may produce, keyed by the `schemaName`
   * callers pass. This registry is the whole mechanism — see the file header.
   */
  readonly schemas: Readonly<Record<string, z.ZodType<unknown>>>;
  /** Override the task name (e.g. to run two with different queues). */
  readonly name?: string;
  readonly queue?: string;
  readonly concurrency?: number;
  readonly timeout?: number;
}

/**
 * Build the task that performs a durable, retryable, restart-surviving
 * structured generation. Hand it to `createOrchestrationPackage({ tasks: [...] })`.
 */
export function createAiGenerationTask(
  options: CreateAiGenerationTaskOptions,
): ResolvedTask<AiGenerationTaskInput, AiGenerationTaskOutput> {
  const names = Object.keys(options.schemas);
  if (names.length === 0) {
    throw new AiConfigError(
      'createAiGenerationTask() requires at least one entry in `schemas`. The queued job carries ' +
        'only a schema NAME (a zod schema cannot be serialized), so the worker needs a registry ' +
        'to look the real schema up in.',
    );
  }

  const taskName = options.name ?? AI_GENERATION_TASK_NAME;
  // Tell the plugin what this task can produce, so `supports()` is answered from
  // the real registry rather than a second, drift-prone list in app config.
  registerBackgroundSchemas(taskName, names);

  return defineTask({
    name: taskName,
    description: 'Generate structured output via slingshot-ai, durably.',
    input: taskInputSchema,
    output: taskOutputSchema,
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    // Generation is slow and thinking makes it slower. The engine default would
    // reap a legitimate Opus call mid-flight.
    timeout: options.timeout ?? 300_000,

    async handler(input, ctx) {
      const schema = options.schemas[input.schemaName];
      if (!schema) {
        throw new AiConfigError(
          `Background generation asked for schema '${input.schemaName}', which is not registered ` +
            `with this task. Registered: ${names.join(', ')}.`,
        );
      }

      const ai = ctx.services?.capabilities.require(AiClientCap);
      if (!ai) {
        throw new AiConfigError(
          'The AI generation task ran without access to package capabilities, so it cannot reach ' +
            'the AI client. The orchestration package must be constructed with the app instance.',
        );
      }

      // The whole pipeline runs on the worker: spend guard, retries, structured
      // repair, moderation. A background job is not a shortcut around any of it
      // — it is the same call, on a different thread of control.
      const result = await ai.generateStructured({
        schema,
        schemaName: input.schemaName,
        messages: input.request.messages as readonly AiMessage[],
        ...(input.request.system !== undefined ? { system: input.request.system as never } : {}),
        ...(input.request.provider ? { provider: input.request.provider } : {}),
        ...(input.request.model ? { model: input.request.model } : {}),
        ...(input.request.effort ? { effort: input.request.effort as AiEffort } : {}),
        ...(input.request.maxTokens ? { maxTokens: input.request.maxTokens } : {}),
        ...(input.request.thinking !== undefined ? { thinking: input.request.thinking } : {}),
        ...(input.request.timeoutMs ? { timeoutMs: input.request.timeoutMs } : {}),
        ...(input.request.promptCacheKey ? { promptCacheKey: input.request.promptCacheKey } : {}),
        ...(input.request.tags ? { tags: input.request.tags } : {}),
        // The task's own AbortSignal — so cancelling the run cancels the HTTP
        // call, rather than leaving it to finish and bill for a result nobody
        // will read.
        signal: ctx.signal,
      });

      return {
        value: result.value,
        provider: result.provider,
        model: result.model,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
        },
      };
    },
  });
}
