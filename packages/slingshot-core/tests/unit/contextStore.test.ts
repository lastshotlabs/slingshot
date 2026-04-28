import { describe, expect, test } from 'bun:test';
import {
  attachContext,
  getContext,
  getContextOrNull,
  isContextObject,
} from '../../src/context/contextStore';
import type { SlingshotContext } from '../../src/context/slingshotContext';
import { createDefaultIdentityResolver } from '../../src/identity';

function createContextFixture(
  overrides: Record<string, unknown> = {},
): SlingshotContext & Record<string, unknown> {
  return {
    config: {},
    persistence: {},
    routeAuth: null,
    actorResolver: null,
    identityResolver: createDefaultIdentityResolver(),
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    pluginState: new Map(),
    ...overrides,
  } as unknown as SlingshotContext & Record<string, unknown>;
}

describe('isContextObject', () => {
  test('returns false for a plain object without the brand', () => {
    const plain = { config: {} };
    expect(isContextObject(plain)).toBe(false);
  });

  test('returns true after attachContext brands the context', () => {
    const app = { use: () => {} };
    const ctx = createContextFixture();

    expect(isContextObject(ctx)).toBe(false);
    attachContext(app, ctx as never);
    expect(isContextObject(ctx)).toBe(true);
  });
});

describe('attachContext', () => {
  test('attaches context to a plain object without use()', () => {
    const app = {};
    const ctx = createContextFixture();

    attachContext(app, ctx as never);

    expect(getContext(app)).toBe(ctx);
  });

  test('attaches context and installs middleware on objects with use()', () => {
    let middlewareInstalled = false;
    const app = {
      use: () => {
        middlewareInstalled = true;
      },
    };
    const ctx = createContextFixture();

    attachContext(app, ctx as never);

    expect(getContext(app)).toBe(ctx);
    expect(middlewareInstalled).toBe(true);
  });

  test('does not install middleware twice on the same app', () => {
    let callCount = 0;
    const app = {
      use: () => {
        callCount++;
      },
    };
    const ctx = createContextFixture();

    attachContext(app, ctx as never);
    // The same context re-attached should be idempotent
    attachContext(app, ctx as never);

    expect(callCount).toBe(1);
  });

  test('throws when attaching a different context to the same app', () => {
    const app = {};
    const ctx1 = createContextFixture({ marker: 'first' });
    const ctx2 = createContextFixture({ marker: 'second' });

    attachContext(app, ctx1 as never);

    expect(() => attachContext(app, ctx2 as never)).toThrow(
      'SlingshotContext is already attached to this app instance',
    );
  });

  test('is idempotent when the same context is re-attached', () => {
    const app = {};
    const ctx = createContextFixture();

    attachContext(app, ctx as never);

    expect(() => attachContext(app, ctx as never)).not.toThrow();
    expect(getContext(app)).toBe(ctx);
  });

  test('brands an unbranded context object during attachment', () => {
    const app = {};
    const ctx = createContextFixture();

    expect(isContextObject(ctx)).toBe(false);
    attachContext(app, ctx as never);
    expect(isContextObject(ctx)).toBe(true);
  });

  test('does not re-brand an already-branded context', () => {
    const app1 = {};
    const app2 = {};
    const ctx = createContextFixture();

    // Brand via first attachment
    attachContext(app1, ctx as never);
    expect(isContextObject(ctx)).toBe(true);

    // Attaching to a second app should not fail on re-branding
    attachContext(app2, ctx as never);
    expect(getContext(app2)).toBe(ctx);
  });

  test('context symbol is non-enumerable on the app', () => {
    const app = {};
    const ctx = createContextFixture();

    attachContext(app, ctx as never);

    // The context symbol should not appear in enumerable keys
    expect(Object.keys(app)).toEqual([]);
    // But getContext should still find it
    expect(getContext(app)).toBe(ctx);
  });
});

describe('getContext', () => {
  test('throws when no context is attached', () => {
    const app = {};
    expect(() => getContext(app)).toThrow('SlingshotContext not found');
  });

  test('returns the attached context', () => {
    const app = {};
    const ctx = createContextFixture();

    attachContext(app, ctx as never);
    expect(getContext(app)).toBe(ctx);
  });
});

describe('getContextOrNull', () => {
  test('returns null when no context is attached', () => {
    const app = {};
    expect(getContextOrNull(app)).toBeNull();
  });

  test('returns the attached context', () => {
    const app = {};
    const ctx = createContextFixture();

    attachContext(app, ctx as never);
    expect(getContextOrNull(app)).toBe(ctx);
  });
});
