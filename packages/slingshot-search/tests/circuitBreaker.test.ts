/**
 * Typesense provider circuit breaker tests.
 *
 * Drives the breaker deterministically by injecting a mock `fetch` and a
 * fake clock via `config.now`. Verifies the closed → open → half-open → closed
 * cycle, fail-fast behaviour while open, and recovery via a successful probe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ProviderUnavailableError, createTypesenseProvider } from '../src/providers/typesense';

// Track the original global fetch so we can restore between tests.
type FetchFn = typeof fetch;
const originalFetch: FetchFn = globalThis.fetch as FetchFn;

interface FakeClock {
  now: number;
  advance(ms: number): void;
}

function makeClock(start = 0): FakeClock {
  return {
    now: start,
    advance(ms) {
      this.now += ms;
    },
  };
}

describe('typesense circuit breaker', () => {
  let clock: FakeClock;
  let fetchCalls: number;

  beforeEach(() => {
    clock = makeClock();
    fetchCalls = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('opens after threshold consecutive failures and fails fast with PROVIDER_UNAVAILABLE', async () => {
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.reject(new Error('connection refused'));
    }) as unknown as FetchFn;

    const provider = createTypesenseProvider({
      provider: 'typesense',
      url: 'http://localhost:8108',
      apiKey: 'test',
      retries: 0,
      retryDelayMs: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 1000,
      now: () => clock.now,
    });

    // 3 consecutive failures trip the breaker.
    for (let i = 0; i < 3; i++) {
      await expect(provider.healthCheck()).resolves.toMatchObject({ healthy: false });
    }
    expect(fetchCalls).toBe(3);

    // The next call must short-circuit BEFORE invoking fetch.
    const callsBefore = fetchCalls;
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.circuitBreaker?.state).toBe('open');
    expect(fetchCalls).toBe(callsBefore); // no new fetch — fail fast

    // A direct provider operation should throw a ProviderUnavailableError.
    await expect(provider.deleteIndex('foo')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('transitions open → half-open after cooldown and recovers on probe success', async () => {
    let shouldFail = true;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (shouldFail) throw new Error('connection refused');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as FetchFn;

    const provider = createTypesenseProvider({
      provider: 'typesense',
      url: 'http://localhost:8108',
      apiKey: 'test',
      retries: 0,
      retryDelayMs: 1,
      circuitBreakerThreshold: 2,
      circuitBreakerCooldownMs: 500,
      now: () => clock.now,
    });

    // Trip the breaker with 2 failures.
    await provider.healthCheck();
    await provider.healthCheck();
    expect((await provider.healthCheck()).circuitBreaker?.state).toBe('open');

    // Within the cooldown — still open, still fails fast.
    clock.advance(100);
    await expect(provider.deleteIndex('x')).rejects.toBeInstanceOf(ProviderUnavailableError);

    // After cooldown, the next call probes (half-open). Make it succeed.
    clock.advance(500);
    shouldFail = false;
    const recovered = await provider.healthCheck();
    expect(recovered.healthy).toBe(true);
    expect(recovered.circuitBreaker?.state).toBe('closed');

    // Subsequent calls go through normally.
    const after = await provider.healthCheck();
    expect(after.healthy).toBe(true);
    expect(after.circuitBreaker?.state).toBe('closed');
  });

  it('half-open probe failure re-opens the breaker', async () => {
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.reject(new Error('still down'));
    }) as unknown as FetchFn;

    const provider = createTypesenseProvider({
      provider: 'typesense',
      url: 'http://localhost:8108',
      apiKey: 'test',
      retries: 0,
      retryDelayMs: 1,
      circuitBreakerThreshold: 1,
      circuitBreakerCooldownMs: 500,
      now: () => clock.now,
    });

    // 1 failure — opens.
    await provider.healthCheck();
    expect((await provider.healthCheck()).circuitBreaker?.state).toBe('open');

    // Move past cooldown — half-open probe is admitted; it fails; re-open.
    clock.advance(600);
    const probe = await provider.healthCheck();
    expect(probe.healthy).toBe(false);
    expect(probe.circuitBreaker?.state).toBe('open');

    // Next call still fails fast (breaker reopened with new openedAt).
    const callsBefore = fetchCalls;
    await expect(provider.deleteIndex('x')).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(fetchCalls).toBe(callsBefore);
  });

  it('does not trip on 4xx client errors that are not 408 / 429', async () => {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('bad request', { status: 400 });
    }) as unknown as FetchFn;

    const provider = createTypesenseProvider({
      provider: 'typesense',
      url: 'http://localhost:8108',
      apiKey: 'test',
      retries: 0,
      circuitBreakerThreshold: 2,
      circuitBreakerCooldownMs: 1000,
      now: () => clock.now,
    });

    // Fire 5 calls — they all 400, breaker should remain closed because
    // the host responded normally to each request.
    for (let i = 0; i < 5; i++) {
      await provider.healthCheck();
    }
    const health = await provider.healthCheck();
    expect(health.circuitBreaker?.state).toBe('closed');
  });
});
