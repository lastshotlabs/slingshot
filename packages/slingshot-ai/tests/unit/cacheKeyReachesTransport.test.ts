/**
 * The prompt cache key must reach the TRANSPORT, not just the drift detectors.
 *
 * On an automatic-caching provider the key is a wire parameter: xAI carries it as
 * `x-grok-conv-id` and uses it to route the request to the machine that already
 * holds the prefix. Omit the header and each call may land somewhere cold, so the
 * whole prefix is re-read at full price.
 *
 * The orchestrator used to forward `req.promptCacheKey` — an OPTIONAL field that
 * no real caller passes — while handing the DERIVED key (from `renderSystem`) to
 * the monitor alone. So the header was absent on every real call.
 *
 * Measured against xAI with hotseat's 4,955-token prefix:
 *
 *     no header    → 128 cached tokens   (2.6%)   ← what production was doing
 *     with header  → 4,928 cached tokens (99.5%)
 *
 * ~10× the input bill, no error, no degradation, and a `cacheHitRate` of 0.026
 * sitting in `/status` as the only evidence. That number is monitored precisely
 * because this failure is otherwise invisible — but a metric only catches it AFTER
 * the money is spent. These tests catch it before.
 */
import { describe, expect, test } from 'bun:test';
import { aiPackageConfigSchema } from '../../src/config';
import { createAiClient } from '../../src/lib/client';
import { createFakeAiProvider } from '../../src/testing';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function build(provider: ReturnType<typeof createFakeAiProvider>) {
  const config = aiPackageConfigSchema.parse({
    providers: { test: { provider } },
    defaultProvider: 'test',
  });
  return createAiClient({
    config,
    providers: new Map([['test', provider]]),
    logger: silentLogger,
  }).client;
}

/** A cached system prompt, exactly as an app declares one — with no cache key. */
const system = {
  stable: [
    { id: 'role', text: 'You deal cards.' },
    { id: 'house-rules', text: 'Never name a person who is not at the table.' },
  ],
  volatile: [{ id: 'roster', text: 'Ana, Ben' }],
};

const ask = { messages: [{ role: 'user' as const, content: 'go' }] };

describe('promptCacheKey reaches the provider', () => {
  test('a caller who passes no key still gets one on the wire', async () => {
    const provider = createFakeAiProvider({ responses: ['a'] });
    await build(provider).generate({ system, ...ask });

    // The failing assertion. `req.promptCacheKey` is undefined here, so the old
    // code put `undefined` on the request and the preset omitted the header.
    expect(provider.calls[0]?.promptCacheKey).toBeTruthy();
  });

  test('the same prefix yields the same key — that is the whole point', async () => {
    const provider = createFakeAiProvider({ responses: ['a', 'b'] });
    const client = build(provider);

    // Same stable prefix, DIFFERENT volatile content and a different question:
    // this is what two consecutive deals in one match look like.
    await client.generate({ system, ...ask });
    await client.generate({
      system: { ...system, volatile: [{ id: 'roster', text: 'Ana, Ben, Carla' }] },
      messages: [{ role: 'user', content: 'again' }],
    });

    const [first, second] = provider.calls;
    // `toBe` ALONE passes vacuously on the bug — `undefined === undefined` reads as
    // "the keys match" and certifies the broken build green. Pin truthiness first.
    expect(first?.promptCacheKey).toBeTruthy();
    expect(first?.promptCacheKey).toBe(second?.promptCacheKey as string);
  });

  test('a different prefix yields a different key', async () => {
    const provider = createFakeAiProvider({ responses: ['a', 'b'] });
    const client = build(provider);

    await client.generate({ system, ...ask });
    await client.generate({
      system: { stable: [{ id: 'role-spicy', text: 'You deal spicier cards.' }] },
      ...ask,
    });

    // Routing a `spicy` call to the machine holding the `family` prefix would be
    // a guaranteed cold read. Distinct tiers must be distinct keys.
    expect(provider.calls[0]?.promptCacheKey).not.toBe(provider.calls[1]?.promptCacheKey as string);
  });

  test('same segment IDS, different TEXT — must NOT share a key', async () => {
    const provider = createFakeAiProvider({ responses: ['a', 'b', 'c'] });
    const client = build(provider);

    // This is hotseat's three spice tiers, exactly: identical segment ids, and the
    // tier lives in the TEXT. Keying on ids collapsed all three onto one routing
    // key, so they landed on the same grok machine and serially EVICTED each other
    // — all three boot pre-warms, whose only job is to warm the cache, missed.
    for (const tier of ['family', 'party', 'spicy']) {
      await client.generate({
        system: { stable: [{ id: 'tier-policy', text: `Write ${tier} cards.` }] },
        ...ask,
      });
    }

    const keys = provider.calls.map(c => c.promptCacheKey);
    expect(new Set(keys).size).toBe(3);
  });

  test('byte-identical prefixes DO share a key, whatever the segment is called', async () => {
    const provider = createFakeAiProvider({ responses: ['a', 'b'] });
    const client = build(provider);
    const stable = [{ id: 'role', text: 'You deal cards.' }];

    await client.generate({ system: { stable }, ...ask });
    await client.generate({ system: { stable }, ...ask });

    // The other half of the contract. Routing by content is only correct if the
    // SAME content still converges — otherwise nothing would ever hit at all.
    expect(provider.calls[0]?.promptCacheKey).toBe(provider.calls[1]?.promptCacheKey as string);
  });

  test('an explicit key from the app still wins', async () => {
    const provider = createFakeAiProvider({ responses: ['a'] });
    await build(provider).generate({ system, promptCacheKey: 'mine', ...ask });

    expect(provider.calls[0]?.promptCacheKey).toBe('mine');
  });
});
