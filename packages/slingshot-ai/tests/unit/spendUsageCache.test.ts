/**
 * Spend, usage persistence, and the response cache / coalescing split.
 *
 * These are the money paths. The theme is that every one of them has a plausible
 * implementation that is quietly, expensively wrong: a spend guard that resets on
 * restart, a summary that sums unknown costs as zero, a coalescer that only runs
 * when caching is on (i.e. never, in the default config).
 */
import { describe, expect, test } from 'bun:test';
import { aiPackageConfigSchema } from '../../src/config';
import { AiSpendLimitError } from '../../src/errors';
import { createAiClient } from '../../src/lib/client';
import type { AiCacheAdapter, AiEventBus, AiUsageRow, AiUsageStore } from '../../src/lib/seams';
import { createFakeAiProvider } from '../../src/testing';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ask = { messages: [{ role: 'user' as const, content: 'go' }] };

/** A provider that is priced, so cost is a real number rather than null. */
function pricedProvider(overrides: Parameters<typeof createFakeAiProvider>[0] = {}) {
  return createFakeAiProvider({
    kind: 'anthropic',
    defaultModel: 'claude-haiku-4-5',
    capabilities: { costAccounting: true, usageAccounting: 'full', maxOutputTokens: 4096 },
    responses: ['ok'],
    ...overrides,
  });
}

function build(
  provider: ReturnType<typeof createFakeAiProvider>,
  overrides: Record<string, unknown> = {},
  deps: {
    store?: AiUsageStore;
    cache?: AiCacheAdapter;
    bus?: AiEventBus;
  } = {},
) {
  const config = aiPackageConfigSchema.parse({
    providers: { test: { kind: 'anthropic', provider } },
    defaultProvider: 'test',
    ...overrides,
  });
  return createAiClient({
    config,
    providers: new Map([['test', provider]]),
    logger: silentLogger,
    ...deps,
  });
}

/** An in-memory stand-in for the entity adapter. */
function memoryStore(seed: AiUsageRow[] = []): AiUsageStore & { rows: AiUsageRow[] } {
  const rows = [...seed];
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

describe('spend guard', () => {
  test('refuses the call BEFORE it is made when it would cross the hard limit', async () => {
    const provider = pricedProvider();
    const { client } = build(provider, {
      spend: { hardLimitUsd: 0.0000001 },
      defaults: { maxTokens: 4096 },
    });

    await expect(client.generate(ask)).rejects.toThrow(AiSpendLimitError);
    // The point of pre-flight: the provider was never called at all. A post-hoc
    // check would have let this through and told us afterwards.
    expect(provider.calls).toHaveLength(0);
  });

  test('hydrates the current window from the ledger, so a restart does not reset the budget', async () => {
    // The failure this prevents: a crash-loop hands the app a fresh budget on
    // every boot, and a $10/day hard limit spends $10 per restart.
    const store = memoryStore([
      {
        provider: 'test',
        model: 'claude-haiku-4-5',
        operation: 'generate',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 6,
        latencyMs: 10,
        tags: null,
        createdAt: new Date(),
      },
    ]);

    const provider = pricedProvider();
    const { client, usage } = build(
      provider,
      { spend: { hardLimitUsd: 5, period: 'day' } },
      { store },
    );

    // Fresh process: nothing spent yet as far as the in-memory guard knows.
    expect((await usage.spend()).spentUsd).toBe(0);

    await usage.hydrateSpend();

    expect((await usage.spend()).spentUsd).toBe(6);
    expect((await usage.spend()).state).toBe('hard');
    // And the guard now actually refuses, as it would have before the restart.
    await expect(client.generate(ask)).rejects.toThrow(AiSpendLimitError);
  });

  test('emits ai:spend.soft_limit once per period, not once per call', async () => {
    const events: { event: string; payload: unknown }[] = [];
    const bus: AiEventBus = { emit: (event, payload) => events.push({ event, payload }) };

    const provider = pricedProvider({ responses: ['ok', 'ok', 'ok'] });
    const { client } = build(
      provider,
      // Priced so low that the first call trips it.
      { spend: { softLimitUsd: 0.0000001 } },
      { bus },
    );

    await client.generate(ask);
    await client.generate(ask);
    await client.generate(ask);

    // An alert that re-fires on every subsequent request is an alert that gets
    // muted — and a muted spend alert reads as "nothing is wrong".
    const soft = events.filter(e => e.event === 'ai:spend.soft_limit');
    expect(soft).toHaveLength(1);
    expect((soft[0]!.payload as { state: string }).state).toBe('soft');
  });
});

describe('usage', () => {
  test('persists a row per call, keeping costUsd nullable', async () => {
    const store = memoryStore();
    const provider = pricedProvider();
    const { client } = build(provider, {}, { store });

    await client.generate({ ...ask, tags: { feature: 'deck-gen' } });
    // The write is fire-and-forget, so let the microtask land.
    await Bun.sleep(5);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.tags).toEqual({ feature: 'deck-gen' });
    expect(typeof store.rows[0]!.costUsd).toBe('number');
  });

  test('a failing ledger write never fails the generation the player is waiting on', async () => {
    const store: AiUsageStore = {
      write: () => Promise.reject(new Error('database is on fire')),
      since: async () => [],
    };
    const provider = pricedProvider();
    const { client } = build(provider, {}, { store });

    // It is a ledger, not a transaction.
    const result = await client.generate(ask);
    expect(result.value).toBe('ok');
    await Bun.sleep(5);
  });

  test('unknown cost stays null and is counted, never summed as zero', async () => {
    // An unpriced model. `costUsd: null` means UNKNOWN, not free — and a summary
    // that quietly sums unknowns as 0 under-reports the bill while looking
    // authoritative.
    const provider = createFakeAiProvider({
      kind: 'openai-compatible',
      defaultModel: 'llama3.1',
      capabilities: { costAccounting: false },
      responses: ['ok'],
    });
    const { client, usage } = build(provider);

    const result = await client.generate(ask);
    expect(result.usage.costUsd).toBeNull();

    const summary = await usage.summary();
    expect(summary.costUsd).toBe(0);
    expect(summary.unpricedCalls).toBe(1);
    expect(summary.calls).toBe(1);
  });

  test("pricing: 'free' is 0, which is NOT the same as unknown", async () => {
    const provider = createFakeAiProvider({
      kind: 'openai-compatible',
      defaultModel: 'llama3.1',
      capabilities: { costAccounting: true },
      responses: ['ok'],
    });
    const config = aiPackageConfigSchema.parse({
      providers: { test: { kind: 'openai-compatible', provider, pricing: 'free' } },
      defaultProvider: 'test',
    });
    const { client, usage } = createAiClient({
      config,
      providers: new Map([['test', provider]]),
      logger: silentLogger,
    });

    const result = await client.generate(ask);
    expect(result.usage.costUsd).toBe(0);

    const summary = await usage.summary();
    expect(summary.unpricedCalls).toBe(0);
  });
});

describe('response cache vs in-flight coalescing', () => {
  test('coalescing is ON by default even though the cache is OFF by default', async () => {
    // The bug this pins: gating coalescing behind `responseCache.enabled` would
    // silently disable it in the DEFAULT configuration — the one everybody runs.
    // Five guests tapping "generate" at the same instant is one intent.
    let inFlight = 0;
    const provider = createFakeAiProvider({
      handler: () => {
        inFlight++;
        return 'the one answer';
      },
    });
    const { client } = build(provider);

    const results = await Promise.all([
      client.generate(ask),
      client.generate(ask),
      client.generate(ask),
      client.generate(ask),
      client.generate(ask),
    ]);

    expect(results.every(r => r.value === 'the one answer')).toBe(true);
    expect(inFlight).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  test('never coalesces paid work across spend scopes', async () => {
    const provider = createFakeAiProvider({ responses: ['ok'] });
    const { client } = build(provider);

    await Promise.all([
      client.generate({ ...ask, spendScope: 'user-a' }),
      client.generate({ ...ask, spendScope: 'user-b' }),
    ]);

    expect(provider.calls).toHaveLength(2);
  });

  test('but SEQUENTIAL identical calls still hit the provider (variety is preserved)', async () => {
    // Coalescing collapses CONCURRENT requests. It must not turn into a response
    // cache, or every generated deck would be identical.
    const provider = createFakeAiProvider({ handler: (_req, index) => `answer ${index}` });
    const { client } = build(provider);

    const first = await client.generate(ask);
    const second = await client.generate(ask);

    expect(first.value).toBe('answer 0');
    expect(second.value).toBe('answer 1');
    expect(second.cached).toBe('none');
  });

  test('an enabled response cache serves a hit from the cache adapter', async () => {
    const entries = new Map<string, string>();
    const adapter: AiCacheAdapter = {
      name: 'memory',
      get: async key => entries.get(key) ?? null,
      set: async (key, value) => {
        entries.set(key, value);
      },
      del: async key => {
        entries.delete(key);
      },
      isReady: () => true,
    };

    const provider = createFakeAiProvider({ handler: (_req, index) => `answer ${index}` });
    const { client } = build(provider, { responseCache: { enabled: true } }, { cache: adapter });

    const first = await client.generate(ask);
    const second = await client.generate(ask);

    expect(first.cached).toBe('none');
    expect(second.cached).toBe('response');
    expect(second.value).toBe(first.value);
    expect(provider.calls).toHaveLength(1);
    expect(entries.size).toBe(1);
  });

  test('a broken cache degrades to a miss, never to a failed generation', async () => {
    const adapter: AiCacheAdapter = {
      name: 'redis',
      get: () => Promise.reject(new Error('connection reset')),
      set: () => Promise.reject(new Error('connection reset')),
      del: async () => {},
      isReady: () => true,
    };

    const provider = createFakeAiProvider({ responses: ['still works'] });
    const { client } = build(provider, { responseCache: { enabled: true } }, { cache: adapter });

    // A cache is an optimization. A broken one must not take the app down.
    const result = await client.generate(ask);
    expect(result.value).toBe('still works');
  });
});
