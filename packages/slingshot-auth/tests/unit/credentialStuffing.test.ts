/**
 * Unit tests for the credential stuffing detection system.
 *
 * Tests the memory repository directly and the service factory, independent of
 * any HTTP route integration. The integration test in
 * `tests/integration/credential-stuffing-login.test.ts` covers the wired-up
 * login route behavior; these tests focus on the pure detection logic.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type CredentialStuffingRepository,
  type CredentialStuffingService,
  createCredentialStuffingService,
  createMemoryCredentialStuffingRepository,
} from '../../src/lib/credentialStuffing';

// ---------------------------------------------------------------------------
// Memory repository tests
// ---------------------------------------------------------------------------

describe('createMemoryCredentialStuffingRepository', () => {
  let repo: CredentialStuffingRepository;

  beforeEach(() => {
    repo = createMemoryCredentialStuffingRepository();
  });

  test('addToSet returns 1 for the first member', async () => {
    const count = await repo.addToSet('ip:1.2.3.4', 'alice@example.com', 60_000);
    expect(count).toBe(1);
  });

  test('addToSet returns increasing count for distinct members', async () => {
    expect(await repo.addToSet('ip:1.2.3.4', 'alice@example.com', 60_000)).toBe(1);
    expect(await repo.addToSet('ip:1.2.3.4', 'bob@example.com', 60_000)).toBe(2);
    expect(await repo.addToSet('ip:1.2.3.4', 'charlie@example.com', 60_000)).toBe(3);
  });

  test('addToSet deduplicates the same member', async () => {
    expect(await repo.addToSet('ip:1.2.3.4', 'alice@example.com', 60_000)).toBe(1);
    expect(await repo.addToSet('ip:1.2.3.4', 'alice@example.com', 60_000)).toBe(1);
    expect(await repo.addToSet('ip:1.2.3.4', 'alice@example.com', 60_000)).toBe(1);
  });

  test('different keys are isolated', async () => {
    await repo.addToSet('ip:1.1.1.1', 'alice@example.com', 60_000);
    await repo.addToSet('ip:1.1.1.1', 'bob@example.com', 60_000);
    await repo.addToSet('ip:2.2.2.2', 'charlie@example.com', 60_000);

    expect(await repo.getSetSize('ip:1.1.1.1', 60_000)).toBe(2);
    expect(await repo.getSetSize('ip:2.2.2.2', 60_000)).toBe(1);
  });

  test('getSetSize returns 0 for unknown key', async () => {
    expect(await repo.getSetSize('ip:unknown', 60_000)).toBe(0);
  });

  test('getSetSize returns current size without modifying the set', async () => {
    await repo.addToSet('ip:1.2.3.4', 'alice@example.com', 60_000);
    await repo.addToSet('ip:1.2.3.4', 'bob@example.com', 60_000);

    expect(await repo.getSetSize('ip:1.2.3.4', 60_000)).toBe(2);
    // Calling getSetSize again does not change the count
    expect(await repo.getSetSize('ip:1.2.3.4', 60_000)).toBe(2);
  });

  test('expired entries return 0 from getSetSize', async () => {
    // Use a 1ms window so the entry expires almost immediately
    await repo.addToSet('ip:1.2.3.4', 'alice@example.com', 1);

    // Wait for expiry
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(await repo.getSetSize('ip:1.2.3.4', 1)).toBe(0);
  });

  test('expired entries are evicted and a fresh set is created on next addToSet', async () => {
    await repo.addToSet('ip:1.2.3.4', 'alice@example.com', 1);
    await repo.addToSet('ip:1.2.3.4', 'bob@example.com', 1);

    await new Promise(resolve => setTimeout(resolve, 10));

    // After expiry, adding a new member starts the count from 1 (fresh set)
    const count = await repo.addToSet('ip:1.2.3.4', 'charlie@example.com', 60_000);
    expect(count).toBe(1);
  });

  test('account-keyed sets work the same as ip-keyed sets', async () => {
    expect(await repo.addToSet('account:alice@example.com', '1.1.1.1', 60_000)).toBe(1);
    expect(await repo.addToSet('account:alice@example.com', '2.2.2.2', 60_000)).toBe(2);
    expect(await repo.addToSet('account:alice@example.com', '3.3.3.3', 60_000)).toBe(3);
    expect(await repo.getSetSize('account:alice@example.com', 60_000)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Service tests
// ---------------------------------------------------------------------------

describe('createCredentialStuffingService', () => {
  let repo: CredentialStuffingRepository;

  beforeEach(() => {
    repo = createMemoryCredentialStuffingRepository();
  });

  test('returns an object with trackFailedLogin and isStuffingBlocked', () => {
    const service = createCredentialStuffingService({}, repo);
    expect(typeof service.trackFailedLogin).toBe('function');
    expect(typeof service.isStuffingBlocked).toBe('function');
  });

  // -------------------------------------------------------------------------
  // IP → accounts threshold
  // -------------------------------------------------------------------------

  describe('maxAccountsPerIp threshold', () => {
    let service: CredentialStuffingService;

    beforeEach(() => {
      service = createCredentialStuffingService(
        { maxAccountsPerIp: { count: 3, windowMs: 60_000 } },
        repo,
      );
    });

    test('below threshold: trackFailedLogin returns false', async () => {
      expect(await service.trackFailedLogin('10.0.0.1', 'a@test.com')).toBe(false);
      expect(await service.trackFailedLogin('10.0.0.1', 'b@test.com')).toBe(false);
    });

    test('at threshold: trackFailedLogin returns true', async () => {
      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      await service.trackFailedLogin('10.0.0.1', 'b@test.com');
      // 3rd distinct account from same IP crosses the threshold (count=3 >= 3)
      expect(await service.trackFailedLogin('10.0.0.1', 'c@test.com')).toBe(true);
    });

    test('above threshold: trackFailedLogin continues returning true', async () => {
      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      await service.trackFailedLogin('10.0.0.1', 'b@test.com');
      await service.trackFailedLogin('10.0.0.1', 'c@test.com');
      // 4th distinct account — still above threshold
      expect(await service.trackFailedLogin('10.0.0.1', 'd@test.com')).toBe(true);
    });

    test('isStuffingBlocked returns true after threshold is crossed', async () => {
      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      await service.trackFailedLogin('10.0.0.1', 'b@test.com');
      await service.trackFailedLogin('10.0.0.1', 'c@test.com');

      expect(await service.isStuffingBlocked('10.0.0.1', 'any@test.com')).toBe(true);
    });

    test('isStuffingBlocked returns false when below threshold', async () => {
      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      expect(await service.isStuffingBlocked('10.0.0.1', 'a@test.com')).toBe(false);
    });

    test('repeated attempts with the same account do not increase count', async () => {
      // Same IP + same account repeated — deduplicated by the set
      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      await service.trackFailedLogin('10.0.0.1', 'a@test.com');

      expect(await service.isStuffingBlocked('10.0.0.1', 'a@test.com')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Account → IPs threshold
  // -------------------------------------------------------------------------

  describe('maxIpsPerAccount threshold', () => {
    let service: CredentialStuffingService;

    beforeEach(() => {
      service = createCredentialStuffingService(
        {
          maxAccountsPerIp: { count: 100, windowMs: 60_000 }, // high — won't trigger
          maxIpsPerAccount: { count: 3, windowMs: 60_000 },
        },
        repo,
      );
    });

    test('below threshold: trackFailedLogin returns false', async () => {
      expect(await service.trackFailedLogin('10.0.0.1', 'victim@test.com')).toBe(false);
      expect(await service.trackFailedLogin('10.0.0.2', 'victim@test.com')).toBe(false);
    });

    test('at threshold: trackFailedLogin returns true', async () => {
      await service.trackFailedLogin('10.0.0.1', 'victim@test.com');
      await service.trackFailedLogin('10.0.0.2', 'victim@test.com');
      // 3rd distinct IP for same account crosses the threshold
      expect(await service.trackFailedLogin('10.0.0.3', 'victim@test.com')).toBe(true);
    });

    test('isStuffingBlocked returns true after account threshold is crossed', async () => {
      await service.trackFailedLogin('10.0.0.1', 'victim@test.com');
      await service.trackFailedLogin('10.0.0.2', 'victim@test.com');
      await service.trackFailedLogin('10.0.0.3', 'victim@test.com');

      expect(await service.isStuffingBlocked('10.0.0.99', 'victim@test.com')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // IP isolation
  // -------------------------------------------------------------------------

  test('different IPs are isolated: attempts from IP-A do not affect IP-B', async () => {
    const service = createCredentialStuffingService(
      { maxAccountsPerIp: { count: 2, windowMs: 60_000 } },
      repo,
    );

    // IP-A hits the threshold
    await service.trackFailedLogin('10.0.0.1', 'a@test.com');
    await service.trackFailedLogin('10.0.0.1', 'b@test.com');
    expect(await service.isStuffingBlocked('10.0.0.1', 'x@test.com')).toBe(true);

    // IP-B is unaffected
    expect(await service.isStuffingBlocked('10.0.0.2', 'x@test.com')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // onDetected callback
  // -------------------------------------------------------------------------

  describe('onDetected callback', () => {
    test('fires when IP threshold is crossed', async () => {
      const signals: Array<{ type: string; key: string; count: number }> = [];
      const service = createCredentialStuffingService(
        {
          maxAccountsPerIp: { count: 2, windowMs: 60_000 },
          onDetected: signal => signals.push(signal),
        },
        repo,
      );

      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      expect(signals).toHaveLength(0);

      await service.trackFailedLogin('10.0.0.1', 'b@test.com');
      expect(signals).toHaveLength(1);
      expect(signals[0]).toEqual({ type: 'ip', key: '10.0.0.1', count: 2 });
    });

    test('fires when account threshold is crossed', async () => {
      const signals: Array<{ type: string; key: string; count: number }> = [];
      const service = createCredentialStuffingService(
        {
          maxAccountsPerIp: { count: 100, windowMs: 60_000 },
          maxIpsPerAccount: { count: 2, windowMs: 60_000 },
          onDetected: signal => signals.push(signal),
        },
        repo,
      );

      await service.trackFailedLogin('10.0.0.1', 'victim@test.com');
      expect(signals).toHaveLength(0);

      await service.trackFailedLogin('10.0.0.2', 'victim@test.com');
      expect(signals).toHaveLength(1);
      expect(signals[0]).toEqual({ type: 'account', key: 'victim@test.com', count: 2 });
    });

    test('fires on every call that exceeds the threshold (no dedup)', async () => {
      const signals: Array<{ type: string; key: string; count: number }> = [];
      const service = createCredentialStuffingService(
        {
          maxAccountsPerIp: { count: 2, windowMs: 60_000 },
          onDetected: signal => signals.push(signal),
        },
        repo,
      );

      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      await service.trackFailedLogin('10.0.0.1', 'b@test.com'); // crosses threshold
      await service.trackFailedLogin('10.0.0.1', 'c@test.com'); // still above threshold

      expect(signals).toHaveLength(2);
    });

    test('a throwing onDetected callback does not break trackFailedLogin', async () => {
      const service = createCredentialStuffingService(
        {
          maxAccountsPerIp: { count: 2, windowMs: 60_000 },
          onDetected: () => {
            throw new Error('callback boom');
          },
        },
        repo,
      );

      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      // Should not throw — the callback error is swallowed
      const result = await service.trackFailedLogin('10.0.0.1', 'b@test.com');
      expect(result).toBe(true);
    });

    test('IP signal short-circuits: account signal is not checked when IP already triggers', async () => {
      const signals: Array<{ type: string; key: string; count: number }> = [];
      const service = createCredentialStuffingService(
        {
          maxAccountsPerIp: { count: 2, windowMs: 60_000 },
          maxIpsPerAccount: { count: 2, windowMs: 60_000 },
          onDetected: signal => signals.push(signal),
        },
        repo,
      );

      // Both thresholds are 2. Use 2 distinct IPs targeting 2 distinct accounts
      // from the same source IP to trigger the IP signal first.
      await service.trackFailedLogin('10.0.0.1', 'a@test.com');
      await service.trackFailedLogin('10.0.0.1', 'b@test.com'); // IP crosses at 2

      // Only the IP signal fires — account signal is skipped
      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe('ip');
    });
  });

  // -------------------------------------------------------------------------
  // Default thresholds
  // -------------------------------------------------------------------------

  test('uses default thresholds when config omits them', async () => {
    const service = createCredentialStuffingService({}, repo);

    // Default maxAccountsPerIp is 5. Send 4 distinct accounts — should not block.
    for (let i = 0; i < 4; i++) {
      expect(await service.trackFailedLogin('10.0.0.1', `user${i}@test.com`)).toBe(false);
    }
    // 5th distinct account crosses the default threshold
    expect(await service.trackFailedLogin('10.0.0.1', 'user4@test.com')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Window expiry
  // -------------------------------------------------------------------------

  test('blocking resets after the window expires', async () => {
    const service = createCredentialStuffingService(
      { maxAccountsPerIp: { count: 2, windowMs: 50 } }, // 50ms window
      repo,
    );

    await service.trackFailedLogin('10.0.0.1', 'a@test.com');
    await service.trackFailedLogin('10.0.0.1', 'b@test.com');
    expect(await service.isStuffingBlocked('10.0.0.1', 'x@test.com')).toBe(true);

    // Wait for the window to expire
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(await service.isStuffingBlocked('10.0.0.1', 'x@test.com')).toBe(false);
  });

  test('after window expires, new attempts start fresh count', async () => {
    const service = createCredentialStuffingService(
      { maxAccountsPerIp: { count: 2, windowMs: 50 } },
      repo,
    );

    await service.trackFailedLogin('10.0.0.1', 'a@test.com');
    await service.trackFailedLogin('10.0.0.1', 'b@test.com');

    await new Promise(resolve => setTimeout(resolve, 60));

    // After window, first attempt should return false (count resets to 1)
    expect(await service.trackFailedLogin('10.0.0.1', 'c@test.com')).toBe(false);
  });
});
