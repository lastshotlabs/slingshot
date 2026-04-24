/**
 * Unit tests for getAuthenticatedAccountGuardFailure.
 *
 * Targets the uncovered lines:
 * - lines 19-21: throws when actor is missing or anonymous
 */
import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import { describe, expect, test } from 'bun:test';
import { getAuthenticatedAccountGuardFailure } from '../../src/framework/lib/authRouteGuard';

function makeAuthRuntime(overrides?: {
  suspended?: boolean;
  emailVerified?: boolean;
  evaluateUserAccess?: () => Promise<
    | {
        allow: boolean;
        message?: string;
        code?: string;
        reason?: string;
      }
    | boolean
    | void
  >;
}): AuthRuntimeContext {
  return {
    adapter: {
      getSuspended: async () => ({ suspended: overrides?.suspended ?? false }),
      getEmailVerified: async () => overrides?.emailVerified ?? true,
    },
    evaluateUserAccess: overrides?.evaluateUserAccess ?? (async () => undefined),
    config: {
      emailVerification: undefined,
      primaryField: 'email',
    },
  } as unknown as AuthRuntimeContext;
}

/**
 * Build a minimal Hono-like context object that satisfies:
 * - c.get('actor') → Actor object (or null for invalid cases)
 * - c.get('slingshotCtx') → a ctx with pluginState containing AUTH_RUNTIME_KEY
 */
function makeContext(actorId: unknown, opts?: { suspended?: boolean; emailVerified?: boolean }) {
  const pluginState = new Map([[AUTH_RUNTIME_KEY, makeAuthRuntime(opts)]]);
  const slingshotCtx = { pluginState };
  const actor =
    typeof actorId === 'string' && actorId.length > 0
      ? Object.freeze({
          id: actorId,
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        })
      : null;

  const store = new Map<string, unknown>([
    ['actor', actor],
    ['slingshotCtx', slingshotCtx],
  ]);

  return {
    get(key: string) {
      return store.get(key);
    },
  };
}

describe('getAuthenticatedAccountGuardFailure', () => {
  test('throws when actor is null (lines 19-21)', async () => {
    const ctx = makeContext(null);
    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      /authenticated user actor/,
    );
  });

  test('throws when actor is undefined (lines 19-21)', async () => {
    const ctx = makeContext(undefined);
    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      /authenticated user actor/,
    );
  });

  test('throws when actor id is empty string (lines 19-21)', async () => {
    const ctx = makeContext('');
    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      /authenticated user actor/,
    );
  });

  test('throws when actor id is a number', async () => {
    const ctx = makeContext(42);
    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      /authenticated user actor/,
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
    const actor = Object.freeze({
      id: 'user-456',
      kind: 'user' as const,
      tenantId: null,
      sessionId: null,
      roles: null,
      claims: {},
    });
    const store = new Map<string, unknown>([
      ['actor', actor],
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
        getEmailVerified: async () => {
          throw new Error('DB connection lost');
        },
      },
      config: {
        emailVerification: { required: true },
        primaryField: 'email',
      },
    } as unknown as AuthRuntimeContext;

    const pluginState = new Map([[AUTH_RUNTIME_KEY, runtime]]);
    const slingshotCtx = { pluginState };
    const actor = Object.freeze({
      id: 'user-789',
      kind: 'user' as const,
      tenantId: null,
      sessionId: null,
      roles: null,
      claims: {},
    });
    const store = new Map<string, unknown>([
      ['actor', actor],
      ['slingshotCtx', slingshotCtx],
    ]);
    const ctx = { get: (key: string) => store.get(key) };

    await expect(getAuthenticatedAccountGuardFailure(ctx as any)).rejects.toThrow(
      'DB connection lost',
    );
  });

  test('returns custom account-access hook denial when runtime denies continued access', async () => {
    const pluginState = new Map([
      [
        AUTH_RUNTIME_KEY,
        makeAuthRuntime({
          evaluateUserAccess: async () => ({
            allow: false,
            message: 'Account disabled',
            code: 'account_disabled',
          }),
        }),
      ],
    ]);
    const slingshotCtx = { pluginState };
    const actor = Object.freeze({
      id: 'user-999',
      kind: 'user' as const,
      tenantId: null,
      sessionId: null,
      roles: null,
      claims: {},
    });
    const store = new Map<string, unknown>([
      ['actor', actor],
      ['slingshotCtx', slingshotCtx],
    ]);
    const ctx = { get: (key: string) => store.get(key) };

    const result = await getAuthenticatedAccountGuardFailure(ctx as any);
    expect(result).toMatchObject({ error: 'Account disabled', status: 403 });
  });
});
