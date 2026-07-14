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

  test('an explicit key from the app still wins', async () => {
    const provider = createFakeAiProvider({ responses: ['a'] });
    await build(provider).generate({ system, promptCacheKey: 'mine', ...ask });

    expect(provider.calls[0]?.promptCacheKey).toBe('mine');
  });
});
