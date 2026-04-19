import { describe, expect, test } from 'bun:test';
import { attachContext, getContextOrNull } from '../../src/context/contextStore';
import { getRateLimitAdapter, getFingerprintBuilder } from '../../src/rateLimit';

/**
 * Build a minimal context fixture branded via attachContext so resolveContext accepts it.
 * Returns { ctx, app } where ctx is the branded SlingshotContext.
 */
function createBrandedContext(overrides: Record<string, unknown> = {}) {
  const app = { use: () => {} }; // minimal app-like object with use()
  const ctx = {
    config: {},
    persistence: {},
    routeAuth: null,
    userResolver: null,
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    pluginState: new Map(),
    ...overrides,
  };

  // Only attach if not already attached
  if (!getContextOrNull(app)) {
    attachContext(app, ctx as never);
  }

  return { ctx, app };
}

describe('getRateLimitAdapter', () => {
  test('returns the adapter when one is registered', () => {
    const adapter = {
      async trackAttempt(): Promise<boolean> {
        return false;
      },
    };
    const { ctx } = createBrandedContext({ rateLimitAdapter: adapter });

    expect(getRateLimitAdapter(ctx as never)).toBe(adapter);
  });

  test('throws when no adapter is registered (null)', () => {
    const { ctx } = createBrandedContext({ rateLimitAdapter: null });

    expect(() => getRateLimitAdapter(ctx as never)).toThrow(
      'No RateLimitAdapter registered for this app instance.',
    );
  });

  test('resolves via app object (ContextCarrier branch)', () => {
    const adapter = {
      async trackAttempt(): Promise<boolean> {
        return true;
      },
    };
    const { app } = createBrandedContext({ rateLimitAdapter: adapter });

    expect(getRateLimitAdapter(app as never)).toBe(adapter);
  });
});

describe('getFingerprintBuilder', () => {
  test('returns the builder when one is registered', () => {
    const builder = {
      async buildFingerprint(): Promise<string> {
        return 'fp-abc';
      },
    };
    const { ctx } = createBrandedContext({ fingerprintBuilder: builder });

    expect(getFingerprintBuilder(ctx as never)).toBe(builder);
  });

  test('throws when no builder is registered (null)', () => {
    const { ctx } = createBrandedContext({ fingerprintBuilder: null });

    expect(() => getFingerprintBuilder(ctx as never)).toThrow(
      'No FingerprintBuilder registered for this app instance.',
    );
  });
});
