/**
 * Prompt caching across tool-loop iterations.
 *
 * The system prefix does not change between iterations, so iterations 2..n
 * should be near-total cache hits. That is the single biggest cost lever in a
 * multi-iteration turn, and it is also the thing this package has already been
 * burned by twice: every wrong version of prompt-cache routing is SILENT — no
 * error, no degradation, a green suite, and ~10x the input bill.
 *
 * **These assertions read the PER-CALL usage ledger, deliberately, not the
 * blended rate.** The blend is what hid the last one: it showed 0.40 while every
 * cache-warming call in it was missing entirely. A blended number over a tool
 * loop is worse still — iteration 1 is always a cold read by construction, so
 * the average is dragged down by a call that could never have hit, and a
 * genuinely broken iteration 2 looks like a slightly-low average.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { aiPackageConfigSchema } from '../../src/config';
import { createAiClient } from '../../src/lib/client';
import type { AiUsageRow, AiUsageStore } from '../../src/lib/seams';
import type { ProviderToolCall } from '../../src/provider/types';
import { createFakeAiProvider } from '../../src/testing';
import type { AiTool } from '../../src/types';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const lookup: AiTool<{ lift: string }> = {
  name: 'get_lift_trend',
  description: 'Trend for one lift.',
  schema: z.object({ lift: z.string() }),
  execute: () => Promise.resolve({ changeKg: 12 }),
};

const toolCall: ProviderToolCall = {
  id: 'call_1',
  name: 'get_lift_trend',
  argumentsJson: '{"lift":"squat"}',
};

/** A stable prefix long enough that a real provider would cache it. */
const STABLE = 'You are a strength coach. '.repeat(400);

function memoryStore(): AiUsageStore & { rows: AiUsageRow[] } {
  const rows: AiUsageRow[] = [];
  return {
    rows,
    async write(row) {
      rows.push(row);
    },
    async since(since) {
      return rows.filter(row => row.createdAt >= since);
    },
  };
}

describe('the cacheable prefix survives the loop', () => {
  test('every iteration carries the SAME prompt-cache routing key', async () => {
    // The routing key is what makes an "automatic" cache fire at all — without
    // it the request may land on a machine that never saw the prefix. If it
    // changed between iterations, iterations 2..n would each be a cold read on a
    // prefix that is byte-identical, at full price, with nothing reporting it.
    const provider = createFakeAiProvider({
      capabilities: { toolUse: true, promptCaching: 'automatic', usageAccounting: 'full' },
      responses: [{ toolCalls: [toolCall] }, { text: 'up 12kg' }, { text: 'unused' }],
    });
    const config = aiPackageConfigSchema.parse({
      providers: { test: { provider } },
      defaultProvider: 'test',
    });
    const { client } = createAiClient({
      config,
      providers: new Map([['test', provider]]),
      logger: silentLogger,
    });

    await client.generate({
      messages: [{ role: 'user', content: 'How is my squat trending?' }],
      system: { stable: [{ id: 'coach', text: STABLE }] },
      tools: [lookup],
    });

    expect(provider.calls).toHaveLength(2);
    const keys = provider.calls.map(request => request.promptCacheKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]!);

    // And the prefix itself really is byte-identical — the key being stable
    // would not help if the system blocks had drifted.
    expect(provider.calls[1]!.system).toEqual(provider.calls[0]!.system);
  });

  test('the ledger records cache reads PER CALL, so iteration 2 is inspectable', async () => {
    // One row per provider call is what makes this visible at all. A single
    // per-turn row would average iteration 1's mandatory cold read together with
    // iteration 2's hit and report neither.
    const store = memoryStore();
    const provider = createFakeAiProvider({
      capabilities: {
        toolUse: true,
        promptCaching: 'automatic',
        usageAccounting: 'full',
        costAccounting: true,
      },
      responses: [
        {
          toolCalls: [toolCall],
          // Cold: the whole prefix billed at the full input rate.
          usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        {
          text: 'up 12kg',
          // Warm: the same prefix, now a cache read, with only the tool result
          // and the model's own turn billed at full rate.
          usage: { inputTokens: 40, outputTokens: 30, cacheReadTokens: 1000, cacheWriteTokens: 0 },
        },
      ],
    });
    const config = aiPackageConfigSchema.parse({
      providers: {
        test: {
          provider,
          pricing: { 'fake-model-1': { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0.1 } },
        },
      },
      defaultProvider: 'test',
    });
    const { client } = createAiClient({
      config,
      providers: new Map([['test', provider]]),
      logger: silentLogger,
      store,
    });

    const result = await client.generate({
      messages: [{ role: 'user', content: 'How is my squat trending?' }],
      system: { stable: [{ id: 'coach', text: STABLE }] },
      tools: [lookup],
    });
    // The ledger write is fire-and-forget.
    await Bun.sleep(5);

    expect(store.rows).toHaveLength(2);

    // THE assertion, read per call rather than blended: iteration 1 is a cold
    // read by construction; iteration 2 must be a hit.
    expect(store.rows[0]!.cacheReadTokens).toBe(0);
    expect(store.rows[1]!.cacheReadTokens).toBe(1000);

    const hitRate = (row: AiUsageRow): number =>
      row.cacheReadTokens / (row.inputTokens + row.cacheReadTokens);
    expect(hitRate(store.rows[0]!)).toBe(0);
    expect(hitRate(store.rows[1]!)).toBeCloseTo(1000 / 1040, 6);

    // What the blend would have said. It is not wrong, it is uninformative:
    // ~49% reads as "caching is half working" whether iteration 2 hit 96% or 0%.
    const blended =
      store.rows.reduce((sum, row) => sum + row.cacheReadTokens, 0) /
      store.rows.reduce((sum, row) => sum + row.inputTokens + row.cacheReadTokens, 0);
    expect(blended).toBeLessThan(0.5);

    // The four counts stay disjoint within each call and add across them.
    expect(result.usage.inputTokens).toBe(1040);
    expect(result.usage.cacheReadTokens).toBe(1000);
    // (1000 + 20)/1e6 cold, then (40 + 30)/1e6 + 1000*0.1/1e6 warm.
    expect(result.usage.costUsd).toBeCloseTo((1020 + 70 + 100) / 1_000_000, 12);
  });
});
