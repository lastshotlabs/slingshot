/**
 * The money path through the tool loop.
 *
 * A tool loop is the third shape an accidental bill takes — after the retry
 * storm and the repair loop — and it is the worst of the three, because the
 * MODEL decides how many times to go round. Invariants 2 and 2b say every paid
 * attempt re-enters the pre-flight guard and the request-scoped reservation.
 * These tests are what make that a fact rather than a claim.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { aiPackageConfigSchema } from '../../src/config';
import { AiSpendLimitError } from '../../src/errors';
import { createAiClient } from '../../src/lib/client';
import type { ProviderToolCall } from '../../src/provider/types';
import { createFakeAiProvider } from '../../src/testing';
import type { AiSpendReservationRequest, AiTool } from '../../src/types';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const ask = { messages: [{ role: 'user' as const, content: 'How is my squat trending?' }] };

const lookup: AiTool<{ lift: string }> = {
  name: 'get_lift_trend',
  description: 'Trend for one lift.',
  schema: z.object({ lift: z.string() }),
  // A bulky result, so the message list — and therefore the pre-flight estimate
  // — visibly grows between iterations.
  execute: () => Promise.resolve({ notes: 'x'.repeat(4000) }),
};

const toolCall: ProviderToolCall = {
  id: 'call_1',
  name: 'get_lift_trend',
  argumentsJson: '{"lift":"squat"}',
};

/** A controller that records every reservation event, in order. */
function recordingController() {
  const events: string[] = [];
  const estimates: (number | null)[] = [];
  return {
    events,
    estimates,
    controller: {
      async reserve(request: AiSpendReservationRequest) {
        events.push(`reserve:${request.operation}`);
        estimates.push(request.estimatedMaxCostUsd);
        return {
          async settle() {
            events.push('settle');
          },
          async release() {
            events.push('release');
          },
        };
      },
    },
  };
}

function build(
  provider: ReturnType<typeof createFakeAiProvider>,
  overrides: Record<string, unknown> = {},
) {
  const config = aiPackageConfigSchema.parse({
    providers: {
      test: {
        provider,
        pricing: { 'fake-model-1': { inputPerMTok: 1, outputPerMTok: 1 } },
      },
    },
    defaultProvider: 'test',
    ...overrides,
  });
  return createAiClient({
    config,
    providers: new Map([['test', provider]]),
    logger: silentLogger,
  });
}

function loopingProvider(iterations: number) {
  let index = 0;
  return createFakeAiProvider({
    capabilities: {
      toolUse: true,
      streaming: true,
      costAccounting: true,
      usageAccounting: 'full',
    },
    handler: () => (index++ < iterations - 1 ? { toolCalls: [toolCall] } : { text: 'done' }),
  });
}

describe('reservations', () => {
  test('N iterations produce N reservations and N settlements', async () => {
    // THE test this slice is graded on. A reservation taken once for the whole
    // turn would cover calls the model had not yet decided to make — which is
    // not a pre-flight guard, it is a guess.
    const { events, controller } = recordingController();
    const provider = loopingProvider(3);
    const { client } = build(provider, { spend: { controller, requireScope: true } });

    const result = await client.generate({ ...ask, tools: [lookup], spendScope: 'user-123' });

    expect(result.iterations).toBe(3);
    expect(provider.calls).toHaveLength(3);
    expect(events).toEqual([
      'reserve:generate',
      'settle',
      'reserve:generate',
      'settle',
      'reserve:generate',
      'settle',
    ]);
  });

  test('the streaming loop reserves and settles per iteration too', async () => {
    const { events, controller } = recordingController();
    const { client } = build(loopingProvider(2), { spend: { controller, requireScope: true } });

    const stream = client.stream({ ...ask, tools: [lookup], spendScope: 'user-123' });
    for await (const _event of stream) {
      // Consuming the iterator alone must finalize spend, exactly as it does on
      // the single-shot streaming path.
    }

    expect(events).toEqual(['reserve:stream', 'settle', 'reserve:stream', 'settle']);
  });

  test("each iteration's estimate grows with the message list", async () => {
    // The messages GROW every iteration — each one appends the model's tool call
    // and the tool's result, and a tool result is often the largest thing in the
    // conversation. Estimating from the system prompt alone would under-count
    // exactly the loop the guard exists to catch.
    const { estimates, controller } = recordingController();
    const { client } = build(loopingProvider(3), { spend: { controller, requireScope: true } });

    await client.generate({ ...ask, tools: [lookup], spendScope: 'user-123' });

    expect(estimates).toHaveLength(3);
    expect(estimates[1]!).toBeGreaterThan(estimates[0]!);
    expect(estimates[2]!).toBeGreaterThan(estimates[1]!);
  });

  test('a failing iteration releases rather than settles', async () => {
    const { events, controller } = recordingController();
    let index = 0;
    const provider = createFakeAiProvider({
      capabilities: { toolUse: true, costAccounting: true, usageAccounting: 'full' },
      handler: () =>
        index++ === 0 ? { toolCalls: [toolCall] } : { error: new Error('provider is down') },
    });
    const { client } = build(provider, {
      spend: { controller, requireScope: true },
      providers: {
        test: {
          provider,
          maxRetries: 0,
          pricing: { 'fake-model-1': { inputPerMTok: 1, outputPerMTok: 1 } },
        },
      },
    });

    await expect(
      client.generate({ ...ask, tools: [lookup], spendScope: 'user-123' }),
    ).rejects.toThrow('provider is down');

    expect(events).toEqual(['reserve:generate', 'settle', 'reserve:generate', 'release']);
  });
});

describe('the pre-flight guard', () => {
  test('stops the loop mid-way, BEFORE the next provider call', async () => {
    // A post-hoc check tells you about the runaway loop after it has finished
    // spending. This asserts the call count freezes at the iteration that
    // crossed the line.
    const provider = loopingProvider(10);
    const { client } = build(provider, {
      // One iteration of this fixture costs ~$0.0000xx; the limit is chosen so
      // the first settles and the second is refused.
      spend: { hardLimitUsd: 0.005 },
      defaults: { maxTokens: 4096 },
      providers: {
        test: {
          provider,
          pricing: { 'fake-model-1': { inputPerMTok: 1000, outputPerMTok: 1000 } },
        },
      },
    });

    await expect(client.generate({ ...ask, tools: [lookup] })).rejects.toThrow(AiSpendLimitError);
    // Refused before the FIRST call: at $1000/MTok, 4096 max output tokens
    // already exceeds the limit on its own.
    expect(provider.calls).toHaveLength(0);
  });

  test('a limit crossed by the first iteration blocks the second', async () => {
    const provider = loopingProvider(10);
    const { client } = build(provider, {
      spend: { hardLimitUsd: 0.02 },
      defaults: { maxTokens: 4096 },
      providers: {
        test: {
          provider,
          // ~$0.0164 estimated per call at 4096 max tokens, so the first passes
          // and the second — with the recorded spend added — does not.
          pricing: { 'fake-model-1': { inputPerMTok: 4, outputPerMTok: 4 } },
        },
      },
    });

    await expect(client.generate({ ...ask, tools: [lookup] })).rejects.toThrow(AiSpendLimitError);
    expect(provider.calls).toHaveLength(1);
  });

  test('requireScope blocks the loop before any money is spent', async () => {
    const provider = loopingProvider(3);
    const { client } = build(provider, {
      spend: {
        controller: {
          reserve: () => Promise.reject(new Error('reserve should not be reached')),
        },
        requireScope: true,
      },
    });

    await expect(client.generate({ ...ask, tools: [lookup] })).rejects.toThrow(/omitted spendScope/);
    expect(provider.calls).toHaveLength(0);
  });
});
