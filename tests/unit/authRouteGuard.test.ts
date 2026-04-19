/**
 * Unit tests for getAuthenticatedAccountGuardFailure.
 *
 * Targets the uncovered lines:
 * - lines 19-21: throws when authUserId is not a non-empty string
 */
import { describe, expect, test } from 'bun:test';
import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import { getAuthenticatedAccountGuardFailure } from '../../src/framework/lib/authRouteGuard';

function makeAuthRuntime(overrides?: {
  suspended?: boolean;
  emailVerified?: boolean;
}): AuthRuntimeContext {
  return {
    adapter: {
      getSuspended: async () => ({ suspended: overrides?.suspended ?? false }),
      getEmailVerified: async () => overrides?.emailVerified ?? true,
    },
    config: {
      emailVerification: undefined,
      primaryField: 'email',
    },
  } as unknown as AuthRuntimeContext;
}

/**
 * Build a minimal Hono-like context object that satisfies:
 * - c.get('authUserId') → authUserId value
 * - c.get('slingshotCtx') → a ctx with pluginState containing AUTH_RUNTIME_KEY
 */
function makeContext(authUserId: unknown, opts?: { suspended?: boolean; emailVerified?: boolean }) {
  const pluginState = new Map([[AUTH_RUNTIME_KEY, makeAuthRuntime(opts)]]);
  const slingshotCtx = { pluginState };

  const store = new Map<string, unknown>([
    ['authUserId', authUserId],
    ['slingshotCtx', slingshotCtx],
  ]);

  return {
    get(key: string) {
      return store.get(key);
    },
  };
}

describe('getAuthenticatedAccountGuardFailure', () => {
  test('throws when authUserId is null (lines 19-21)', async () => {
    const ctx = makeContext(null);
    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      /authenticated route guard requires/,
    );
  });

  test('throws when authUserId is undefined (lines 19-21)', async () => {
    const ctx = makeContext(undefined);
    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      /authenticated route guard requires/,
    );
  });

  test('throws when authUserId is empty string (lines 19-21)', async () => {
    const ctx = makeContext('');
    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      /authenticated route guard requires/,
    );
  });

  test('throws when authUserId is a number', async () => {
    const ctx = makeContext(42);
    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      /authenticated route guard requires/,
    );
  });

  test('returns null when account is active and email verified', async () => {
    const ctx = makeContext('user-123');
    const result = await getAuthenticatedAccountGuardFailure(ctx as any);
    expect(result).toBeNull();
  });

  test('returns suspended error when account is suspended', async () => {
    const ctx = makeContext('user-123', { suspended: true });
    const result = await getAuthenticatedAccountGuardFailure(ctx as any);
    expect(result).toMatchObject({ error: 'Account suspended', status: 403 });
  });

  test('returns email not verified error when email verification required (lines 32-35)', async () => {
    // Need emailVerification with required: true, primaryField: 'email',
    // and adapter.getEmailVerified returning false
    const runtime = {
      adapter: {
        getSuspended: async () => ({ suspended: false }),
        getEmailVerified: async () => false,
      },
      config: {
        emailVerification: { required: true },
        primaryField: 'email',
      },
    } as unknown as AuthRuntimeContext;

    const pluginState = new Map([[AUTH_RUNTIME_KEY, runtime]]);
    const slingshotCtx = { pluginState };
    const store = new Map<string, unknown>([
      ['authUserId', 'user-456'],
      ['slingshotCtx', slingshotCtx],
    ]);
    const ctx = { get: (key: string) => store.get(key) };

    const result = await getAuthenticatedAccountGuardFailure(ctx as any);
    expect(result).toMatchObject({ error: 'Email not verified', status: 403 });
  });

  test('re-throws non-HttpError exceptions from assertLoginEmailVerified (line 36)', async () => {
    // Make getEmailVerified throw a non-HttpError
    const runtime = {
      adapter: {
        getSuspended: async () => ({ suspended: false }),
        getEmailVerified: async () => { throw new Error('DB connection lost'); },
      },
      config: {
        emailVerification: { required: true },
        primaryField: 'email',
      },
    } as unknown as AuthRuntimeContext;

    const pluginState = new Map([[AUTH_RUNTIME_KEY, runtime]]);
    const slingshotCtx = { pluginState };
    const store = new Map<string, unknown>([
      ['authUserId', 'user-789'],
      ['slingshotCtx', slingshotCtx],
    ]);
    const ctx = { get: (key: string) => store.get(key) };

    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      'DB connection lost',
    );
  });
});
