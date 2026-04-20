import { describe, expect, test } from 'bun:test';
import {
  AUTH_PLUGIN_STATE_KEY,
  evaluateAuthUserAccess,
  getAuthRuntimePeer,
  getAuthRuntimePeerOrNull,
} from '../../src/authPeer';

describe('getAuthRuntimePeerOrNull', () => {
  test('returns null for null input', () => {
    expect(getAuthRuntimePeerOrNull(null)).toBeNull();
  });

  test('returns null when no auth state entry', () => {
    const map = new Map();
    expect(getAuthRuntimePeerOrNull(map)).toBeNull();
  });

  test('returns null when entry is not an object', () => {
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, 'not-object']]);
    expect(getAuthRuntimePeerOrNull(map)).toBeNull();
  });

  test('returns null when adapter is not an object', () => {
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, { adapter: 'string' }]]);
    expect(getAuthRuntimePeerOrNull(map)).toBeNull();
  });

  test('returns null when adapter is null', () => {
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, { adapter: null }]]);
    expect(getAuthRuntimePeerOrNull(map)).toBeNull();
  });

  test('returns peer when adapter is valid object', () => {
    const runtime = { adapter: { findUser: () => {} }, config: { primaryField: 'email' } };
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, runtime]]);
    expect(getAuthRuntimePeerOrNull(map)).toBe(runtime);
  });
});

describe('getAuthRuntimePeer', () => {
  test('throws when not available', () => {
    expect(() => getAuthRuntimePeer(null)).toThrow('auth runtime peer is not available');
  });

  test('returns peer when available', () => {
    const runtime = { adapter: { findUser: () => {} } };
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, runtime]]);
    expect(getAuthRuntimePeer(map)).toBe(runtime);
  });
});

describe('evaluateAuthUserAccess', () => {
  test('allows access when built-in checks pass and no custom hook is defined', async () => {
    const runtime = {
      adapter: {
        async getSuspended() {
          return { suspended: false };
        },
      },
      config: {
        primaryField: 'email',
        emailVerification: { required: false },
      },
    };

    await expect(
      evaluateAuthUserAccess(runtime, {
        userId: 'user-1',
        tenantId: 'tenant-1',
      }),
    ).resolves.toEqual({ allow: true });
  });

  test('denies suspended accounts before custom access policy runs', async () => {
    const runtime = {
      adapter: {
        async getSuspended() {
          return { suspended: true };
        },
      },
      evaluateUserAccess: async () => ({ allow: true }),
    };

    await expect(
      evaluateAuthUserAccess(runtime, {
        userId: 'user-1',
        tenantId: null,
      }),
    ).resolves.toMatchObject({
      allow: false,
      status: 403,
      message: 'Account suspended',
      code: 'account_suspended',
    });
  });

  test('applies a custom user-access policy after the built-in checks', async () => {
    const runtime = {
      adapter: {
        async getSuspended() {
          return { suspended: false };
        },
        async getEmailVerified() {
          return true;
        },
      },
      config: {
        primaryField: 'email',
        emailVerification: { required: true },
      },
      evaluateUserAccess: async () => ({
        allow: false,
        message: 'Account disabled',
        code: 'account_disabled',
        reason: 'account_disabled',
      }),
    };

    await expect(
      evaluateAuthUserAccess(runtime, {
        userId: 'user-1',
        tenantId: null,
        path: '/secure',
      }),
    ).resolves.toMatchObject({
      allow: false,
      status: 403,
      message: 'Account disabled',
      code: 'account_disabled',
      reason: 'account_disabled',
    });
  });
});
