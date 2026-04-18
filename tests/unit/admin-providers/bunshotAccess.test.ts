import { createSlingshotAuthAccessProvider } from '@auth/admin/slingshotAccess';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import type { AdminPrincipal } from '@lastshotlabs/slingshot-core';

// Minimal mock context helper
function makeContext(adapter: AuthAdapter, userId?: string): any {
  const slingshotCtx = {
    pluginState: new Map([
      [
        'slingshot-auth',
        {
          adapter,
          eventBus: { emit: () => {}, on: () => {}, off: () => {} },
          config: {},
        },
      ],
    ]),
  };
  return {
    get: (key: string) => {
      if (key === 'authUserId') return userId;
      if (key === 'slingshotCtx') return slingshotCtx;
      return undefined;
    },
    req: {},
  };
}

// A re-usable mock adapter; individual tests can override specific methods
let mockAdapter: Partial<AuthAdapter>;

beforeEach(() => {
  mockAdapter = {
    async findByEmail() {
      return null;
    },
    async create() {
      return { id: 'x' };
    },
  };
});

describe('createSlingshotAuthAccessProvider — verifyRequest', () => {
  test('returns null when authUserId is absent from context', async () => {
    const provider = createSlingshotAuthAccessProvider();
    const result = await provider.verifyRequest(makeContext(mockAdapter as AuthAdapter, undefined));
    expect(result).toBeNull();
  });

  test('returns null when adapter.getUser returns null/undefined', async () => {
    mockAdapter.getUser = async () => undefined as any;

    const provider = createSlingshotAuthAccessProvider();
    const result = await provider.verifyRequest(makeContext(mockAdapter as AuthAdapter, 'user-1'));
    expect(result).toBeNull();
  });

  test('returns AdminPrincipal with roles when user is found', async () => {
    mockAdapter.getUser = async (_id: string) => ({
      id: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice',
      suspended: false,
    });
    mockAdapter.getRoles = async (_id: string) => ['admin', 'editor'];

    const provider = createSlingshotAuthAccessProvider();
    const result = await provider.verifyRequest(makeContext(mockAdapter as AuthAdapter, 'user-1'));

    expect(result).not.toBeNull();
    const principal = result as AdminPrincipal;
    expect(principal.subject).toBe('user-1');
    expect(principal.email).toBe('alice@example.com');
    expect(principal.displayName).toBe('Alice');
    expect(principal.roles).toEqual(['admin', 'editor']);
    expect(principal.provider).toBe('slingshot-auth');
  });

  test('returns empty roles array when adapter.getRoles is not implemented', async () => {
    mockAdapter.getUser = async (_id: string) => ({
      id: 'user-2',
      email: 'bob@example.com',
      suspended: false,
    });
    // getRoles intentionally absent

    const provider = createSlingshotAuthAccessProvider();
    const result = await provider.verifyRequest(makeContext(mockAdapter as AuthAdapter, 'user-2'));
    expect(result).not.toBeNull();
    expect((result as AdminPrincipal).roles).toEqual([]);
  });
});

// Note: getCapabilities is on ManagedUserProvider, not AdminAccessProvider.
// See slingshotUsers.test.ts for capability tests.
