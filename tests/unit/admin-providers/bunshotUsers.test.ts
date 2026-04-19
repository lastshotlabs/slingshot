import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { SessionRepository } from '@auth/lib/session';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import type { ManagedUserRecord } from '@lastshotlabs/slingshot-core';

const mockSetSuspended = mock(
  async () => {},
);

type ManagedUserProviderModule =
  typeof import('../../../packages/slingshot-auth/src/admin/slingshotUsers');

async function loadManagedUserProviderModule(): Promise<ManagedUserProviderModule> {
  mock.module('@auth/lib/suspension', () => ({
    setSuspended: mockSetSuspended,
  }));

  return import(
    `../../../packages/slingshot-auth/src/admin/slingshotUsers.ts?bunshotUsers=${Date.now()}-${Math.random()}`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseUser(overrides: Record<string, any> = {}) {
  return {
    id: 'user-1',
    email: 'alice@example.com',
    displayName: 'Alice',
    firstName: 'Alice',
    lastName: 'Smith',
    suspended: false,
    ...overrides,
  };
}

let mockAdapter: Partial<AuthAdapter>;
let mockSessionRepo: SessionRepository;
let createSlingshotManagedUserProvider: ManagedUserProviderModule['createSlingshotManagedUserProvider'];

const mockGetUserSessions = mock(async () => [] as any[]);
const mockDeleteSession = mock(async () => {});

beforeEach(async () => {
  mock.restore();
  // Reset call counts on every mock
  mockGetUserSessions.mockReset();
  mockDeleteSession.mockReset();
  mockSetSuspended.mockReset();
  ({ createSlingshotManagedUserProvider } = await loadManagedUserProviderModule());

  mockGetUserSessions.mockImplementation(async () => []);
  mockDeleteSession.mockImplementation(async () => {});
  mockSetSuspended.mockImplementation(async () => {});

  mockSessionRepo = {
    getUserSessions: mockGetUserSessions,
    deleteSession: mockDeleteSession,
    // Stubs for the remaining SessionRepository methods (not exercised in these tests)
    createSession: mock(async () => {}),
    atomicCreateSession: mock(async () => {}),
    getSession: mock(async () => null),
    getActiveSessionCount: mock(async () => 0),
    evictOldestSession: mock(async () => {}),
    updateSessionLastActive: mock(async () => {}),
    setRefreshToken: mock(async () => {}),
    getSessionByRefreshToken: mock(async () => null),
    rotateRefreshToken: mock(async () => true),
    getSessionFingerprint: mock(async () => null),
    setSessionFingerprint: mock(async () => {}),
    setMfaVerifiedAt: mock(async () => {}),
    getMfaVerifiedAt: mock(async () => null),
  } as unknown as SessionRepository;

  mockAdapter = {
    async findByEmail() {
      return null;
    },
    async create() {
      return { id: 'x' };
    },
  };
});

// ---------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------

describe('listUsers', () => {
  test('calls adapter.listUsers with cursor-decoded startIndex', async () => {
    let capturedQuery: any;
    mockAdapter.listUsers = async (q: any) => {
      capturedQuery = q;
      return { users: [], totalResults: 0 };
    };
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    // Encode cursor for offset=10
    const cursor = btoa(JSON.stringify({ offset: 10 }));
    await provider.listUsers({ cursor, limit: 25 });

    expect(capturedQuery.startIndex).toBe(10);
    expect(capturedQuery.count).toBe(26); // limit+1 to detect hasMore
  });

  test('uses defaults (startIndex=0, count=limit+1) when not specified', async () => {
    let capturedQuery: any;
    mockAdapter.listUsers = async (q: any) => {
      capturedQuery = q;
      return { users: [], totalResults: 0 };
    };
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    await provider.listUsers({});

    expect(capturedQuery.startIndex).toBe(0);
    expect(capturedQuery.count).toBe(51); // default limit 50 + 1
  });

  test('passes search term as email filter', async () => {
    let capturedQuery: any;
    mockAdapter.listUsers = async (q: any) => {
      capturedQuery = q;
      return { users: [], totalResults: 0 };
    };
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    await provider.listUsers({ search: 'alice' });

    expect(capturedQuery.email).toBe('alice');
  });

  test('maps users to ManagedUserRecord with correct provider', async () => {
    mockAdapter.listUsers = async () => ({
      users: [baseUser()],
      totalResults: 1,
    });
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const result = await provider.listUsers({});

    expect(result.items).toHaveLength(1);
    const item = result.items[0] as ManagedUserRecord;
    expect(item.id).toBe('user-1');
    expect(item.email).toBe('alice@example.com');
    expect(item.provider).toBe('slingshot-auth');
    expect(item.status).toBe('active');
  });

  test('returns empty list when adapter.listUsers is not implemented', async () => {
    // listUsers not defined on adapter
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const result = await provider.listUsers({});
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getUser
// ---------------------------------------------------------------------------

describe('getUser', () => {
  test('returns null when adapter.getUser returns falsy', async () => {
    mockAdapter.getUser = async () => undefined as any;
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const result = await provider.getUser('missing-user');
    expect(result).toBeNull();
  });

  test('returns ManagedUserRecord when user is found', async () => {
    mockAdapter.getUser = async () => baseUser();
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const result = await provider.getUser('user-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('user-1');
    expect(result!.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// suspendUser / unsuspendUser
// ---------------------------------------------------------------------------

describe('suspendUser', () => {
  test('calls setSuspended with true and reason', async () => {
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    await provider.suspendUser!({ userId: 'user-1', reason: 'abuse', actorId: 'admin-1' });

    expect(mockSetSuspended).toHaveBeenCalledTimes(1);
    expect(mockSetSuspended).toHaveBeenCalledWith(mockAdapter, 'user-1', true, 'abuse');
  });
});

describe('unsuspendUser', () => {
  test('calls setSuspended with false', async () => {
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    await provider.unsuspendUser!({ userId: 'user-1', actorId: 'admin-1' });

    expect(mockSetSuspended).toHaveBeenCalledTimes(1);
    expect(mockSetSuspended).toHaveBeenCalledWith(mockAdapter, 'user-1', false);
  });
});

// ---------------------------------------------------------------------------
// updateUser
// ---------------------------------------------------------------------------

describe('updateUser', () => {
  test('calls adapter.updateProfile and re-fetches the user', async () => {
    let updateProfileCalled = false;
    mockAdapter.updateProfile = async () => {
      updateProfileCalled = true;
    };
    mockAdapter.getUser = async () => baseUser({ displayName: 'Alice Updated' });
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const result = await provider.updateUser!({
      userId: 'user-1',
      displayName: 'Alice Updated',
    });

    expect(updateProfileCalled).toBe(true);
    expect(result!.displayName).toBe('Alice Updated');
  });

  test('returns null when re-fetched user is not found', async () => {
    mockAdapter.updateProfile = async () => {};
    mockAdapter.getUser = async () => undefined as any;
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const result = await provider.updateUser!({ userId: 'ghost' });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteUser
// ---------------------------------------------------------------------------

describe('deleteUser', () => {
  test('deletes sessions then deletes the user', async () => {
    const calls: string[] = [];
    mockGetUserSessions.mockImplementation(async () => {
      return [{ sessionId: 'sess-1', createdAt: 0, lastActiveAt: 0, expiresAt: 0, isActive: true }];
    });
    mockDeleteSession.mockImplementation(async () => {
      calls.push('deleteSession');
    });
    mockAdapter.deleteUser = async () => {
      calls.push('deleteUser');
    };
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    await provider.deleteUser!('user-1');

    expect(mockGetUserSessions).toHaveBeenCalledWith('user-1', DEFAULT_AUTH_CONFIG);
    expect(mockDeleteSession).toHaveBeenCalledWith('sess-1', DEFAULT_AUTH_CONFIG);
    expect(calls).toEqual(['deleteSession', 'deleteUser']);
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('listSessions', () => {
  test('maps SessionInfo to SessionRecord correctly', async () => {
    const now = Date.now();
    mockGetUserSessions.mockImplementation(async () => [
      {
        sessionId: 'sess-abc',
        createdAt: now,
        lastActiveAt: now + 1000,
        expiresAt: now + 86400000,
        ipAddress: '1.2.3.4',
        userAgent: 'Mozilla/5.0',
        isActive: true,
      },
    ]);

    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const sessions = await provider.listSessions!('user-1');

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('sess-abc');
    expect(sessions[0].userId).toBe('user-1');
    expect(sessions[0].ip).toBe('1.2.3.4');
    expect(sessions[0].userAgent).toBe('Mozilla/5.0');
    expect(sessions[0].createdAt).toBe(now);
    expect(sessions[0].lastActiveAt).toBe(now + 1000);
  });
});

// ---------------------------------------------------------------------------
// revokeSession / revokeAllSessions
// ---------------------------------------------------------------------------

describe('revokeSession', () => {
  test('calls deleteSession with the correct sessionId', async () => {
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    await provider.revokeSession!('sess-xyz');

    expect(mockDeleteSession).toHaveBeenCalledTimes(1);
    expect(mockDeleteSession).toHaveBeenCalledWith('sess-xyz', DEFAULT_AUTH_CONFIG);
  });
});

describe('revokeAllSessions', () => {
  test('fetches sessions then deletes each one', async () => {
    mockGetUserSessions.mockImplementation(async () => [
      { sessionId: 'sess-1', createdAt: 0, lastActiveAt: 0, expiresAt: 0, isActive: true },
      { sessionId: 'sess-2', createdAt: 0, lastActiveAt: 0, expiresAt: 0, isActive: true },
    ]);
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    await provider.revokeAllSessions!('user-1');

    expect(mockGetUserSessions).toHaveBeenCalledWith('user-1', DEFAULT_AUTH_CONFIG);
    expect(mockDeleteSession).toHaveBeenCalledTimes(2);
    expect(mockDeleteSession).toHaveBeenCalledWith('sess-1', DEFAULT_AUTH_CONFIG);
    expect(mockDeleteSession).toHaveBeenCalledWith('sess-2', DEFAULT_AUTH_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// toManagedUserRecord (tested indirectly via getUser)
// ---------------------------------------------------------------------------

describe('toManagedUserRecord — status mapping', () => {
  test('status is "suspended" when user.suspended is true', async () => {
    mockAdapter.getUser = async () => baseUser({ suspended: true });
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const result = await provider.getUser('user-1');
    expect(result!.status).toBe('suspended');
  });

  test('status is "active" when user.suspended is false', async () => {
    mockAdapter.getUser = async () => baseUser({ suspended: false });
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const result = await provider.getUser('user-1');
    expect(result!.status).toBe('active');
  });

  test('status is "active" when user.suspended is falsy/absent', async () => {
    mockAdapter.getUser = async () => ({ id: 'user-1', email: 'x@example.com' }) as any;
    const provider = createSlingshotManagedUserProvider(
      mockAdapter as AuthAdapter,
      DEFAULT_AUTH_CONFIG,
      mockSessionRepo,
    );
    const result = await provider.getUser('user-1');
    expect(result!.status).toBe('active');
  });
});
