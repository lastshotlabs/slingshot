/**
 * Background generation.
 *
 * The load-bearing claim: a caller can never mistake an INLINE run for a durable
 * QUEUED one. `AiBackgroundHandle` is a discriminated union precisely so that
 * `{ runId?: string }` — which would let a caller ignore the difference and
 * discover it only when a restart lost someone's deck — is not expressible.
 *
 * The other constraint worth pinning: a zod schema cannot ride a queue, so the
 * job carries the schema NAME and the worker looks the real schema up. A name
 * the worker doesn't know must therefore never be enqueued.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { aiPackageConfigSchema } from '../../src/config';
import { backgroundSchemasFor, resetBackgroundSchemas } from '../../src/lib/backgroundRegistry';
import { type AiBackgroundRunner, createAiClient } from '../../src/lib/client';
import { AI_GENERATION_TASK_NAME, createAiGenerationTask } from '../../src/orchestration';
import { createFakeAiProvider } from '../../src/testing';

type TaskHandler = ReturnType<typeof createAiGenerationTask>['handler'];
type TaskHandlerCtx = Parameters<TaskHandler>[1];

/**
 * The handler context the orchestration engine would hand a worker.
 *
 * Hoisted out of the call sites rather than cast inline: `as never` on an object
 * LITERAL suppresses the shape check as well as the nominal one, so a genuinely
 * wrong fake would typecheck exactly as happily as a right one — which defeats
 * the point of having the worker take a typed context at all.
 */
function handlerCtx(client: unknown): TaskHandlerCtx {
  const ctx = {
    attempt: 1,
    runId: 'run_1',
    signal: new AbortController().signal,
    log: silentLogger,
    reportProgress: () => {},
    services: { capabilities: { require: () => client, maybe: () => client } },
  };
  return ctx as unknown as TaskHandlerCtx;
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DeckSchema = z.object({ cards: z.array(z.string()) });

function build(runner?: AiBackgroundRunner) {
  const provider = createFakeAiProvider({
    capabilities: { structuredOutput: 'native' },
    responses: [{ text: JSON.stringify({ cards: ['a', 'b'] }) }],
  });
  const config = aiPackageConfigSchema.parse({
    providers: { test: { provider } },
    defaultProvider: 'test',
  });
  const { client } = createAiClient({
    config,
    providers: new Map([['test', provider]]),
    logger: silentLogger,
    background: runner ?? null,
  });
  return { client, provider };
}

const req = {
  schema: DeckSchema,
  schemaName: 'deck',
  messages: [{ role: 'user' as const, content: 'make a deck' }],
};

beforeEach(() => resetBackgroundSchemas());

describe('generateStructuredInBackground', () => {
  test('runs INLINE and says so when there is no queue', async () => {
    const { client } = build();

    const handle = await client.generateStructuredInBackground(req);

    expect(handle.mode).toBe('sync');
    // The union is what makes this safe: there is no `runId` to accidentally
    // read, and `result` is only reachable after narrowing on `mode`.
    if (handle.mode !== 'sync') throw new Error('unreachable');
    expect(handle.result.value).toEqual({ cards: ['a', 'b'] });
  });

  test('QUEUES when a runner supports the schema, returning a run id', async () => {
    const enqueued: unknown[] = [];
    const runner: AiBackgroundRunner = {
      supports: name => name === 'deck',
      enqueue: async payload => {
        enqueued.push(payload);
        return 'run_123';
      },
    };

    const { client, provider } = build(runner);
    const handle = await client.generateStructuredInBackground(req);

    expect(handle.mode).toBe('queued');
    if (handle.mode !== 'queued') throw new Error('unreachable');
    expect(handle.runId).toBe('run_123');

    // Nothing was generated here — the work happens on the worker.
    expect(provider.calls).toHaveLength(0);

    // And what rode the queue is serializable: the schema NAME, not the schema.
    const payload = enqueued[0] as { schemaName: string; request: Record<string, unknown> };
    expect(payload.schemaName).toBe('deck');
    expect(payload.request).not.toHaveProperty('schema');
    expect(payload.request).not.toHaveProperty('signal');
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload as never);
  });

  test('falls back to INLINE for a schema the worker would not recognize', async () => {
    // Enqueueing here would create a job that is guaranteed to fail on pickup.
    // Running inline is worse than queued but far better than lost.
    const runner: AiBackgroundRunner = {
      supports: () => false,
      enqueue: async () => {
        throw new Error('should never be reached');
      },
    };

    const { client } = build(runner);
    const handle = await client.generateStructuredInBackground(req);

    expect(handle.mode).toBe('sync');
  });
});

describe('createAiGenerationTask', () => {
  test('registers its schema names so the plugin can answer supports()', () => {
    createAiGenerationTask({ schemas: { deck: DeckSchema, card: z.object({ text: z.string() }) } });

    const registered = backgroundSchemasFor(AI_GENERATION_TASK_NAME);
    expect([...registered].sort()).toEqual(['card', 'deck']);
  });

  test('refuses an empty schema registry rather than accepting jobs it cannot run', () => {
    expect(() => createAiGenerationTask({ schemas: {} })).toThrow(
      /at least one entry in `schemas`/,
    );
  });

  test('the task declares serializable input and output', () => {
    const task = createAiGenerationTask({ schemas: { deck: DeckSchema } });

    expect(task.name).toBe(AI_GENERATION_TASK_NAME);

    const parsed = task.input.parse({
      schemaName: 'deck',
      request: { messages: [{ role: 'user', content: 'go' }] },
    });
    expect(parsed.schemaName).toBe('deck');
  });

  test('the handler generates through the real client and returns the validated value', async () => {
    const task = createAiGenerationTask({ schemas: { deck: DeckSchema } });
    const { client, provider } = build();

    const result = await task.handler(
      { schemaName: 'deck', request: { messages: [{ role: 'user', content: 'go' }] } },
      handlerCtx(client),
    );

    // The full pipeline ran on the worker — this is the same call, on a
    // different thread of control, not a shortcut around validation.
    expect(result.value).toEqual({ cards: ['a', 'b'] });
    expect(provider.calls).toHaveLength(1);
    // `costUsd: null` (unknown) survives the queue boundary as null, not 0.
    expect(result.usage.costUsd).toBeNull();
  });

  test('the handler rejects a schema name it was never given', async () => {
    const task = createAiGenerationTask({ schemas: { deck: DeckSchema } });
    const { client } = build();

    await expect(
      task.handler(
        { schemaName: 'not-registered', request: { messages: [{ role: 'user', content: 'go' }] } },
        handlerCtx(client),
      ),
    ).rejects.toThrow(/not registered with this task/);
  });
});
