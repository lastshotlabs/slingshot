import {
  type LockoutService,
  createLockoutService,
  createMemoryLockoutRepository,
} from '@auth/lib/accountLockout';
import { beforeEach, describe, expect, test } from 'bun:test';

let svc: LockoutService;

beforeEach(() => {
  svc = createLockoutService(
    { maxAttempts: 3, lockoutDuration: 60, resetOnSuccess: true },
    createMemoryLockoutRepository(),
  );
});

describe('recordFailedAttempt', () => {
  test('increments counter and returns new count', async () => {
    const count1 = await svc.recordFailedAttempt('user-1');
    expect(count1).toBe(1);
    const count2 = await svc.recordFailedAttempt('user-1');
    expect(count2).toBe(2);
    const count3 = await svc.recordFailedAttempt('user-1');
    expect(count3).toBe(3);
  });

  test('tracks separate counters per user', async () => {
    await svc.recordFailedAttempt('user-a');
    await svc.recordFailedAttempt('user-a');
    const countA = await svc.recordFailedAttempt('user-a');
    const countB = await svc.recordFailedAttempt('user-b');
    expect(countA).toBe(3);
    expect(countB).toBe(1);
  });
});

describe('isAccountLocked', () => {
  test('returns false for a user with no lockout', async () => {
    expect(await svc.isAccountLocked('user-clean')).toBe(false);
  });

  test('returns false after recordFailedAttempt below maxAttempts', async () => {
    await svc.recordFailedAttempt('user-2');
    await svc.recordFailedAttempt('user-2');
    expect(await svc.isAccountLocked('user-2')).toBe(false);
  });

  test('returns true after lockAccount is called', async () => {
    await svc.lockAccount('user-3');
    expect(await svc.isAccountLocked('user-3')).toBe(true);
  });
});

describe('lockAccount + unlockAccount', () => {
  test('lockAccount sets the lock', async () => {
    await svc.lockAccount('user-5');
    expect(await svc.isAccountLocked('user-5')).toBe(true);
  });

  test('unlockAccount clears the lock', async () => {
    await svc.lockAccount('user-6');
    expect(await svc.isAccountLocked('user-6')).toBe(true);
    await svc.unlockAccount('user-6');
    expect(await svc.isAccountLocked('user-6')).toBe(false);
  });

  test('unlockAccount also resets the failure counter', async () => {
    await svc.recordFailedAttempt('user-7');
    await svc.recordFailedAttempt('user-7');
    await svc.lockAccount('user-7');
    await svc.unlockAccount('user-7');
    // After unlock, a new failure should start at 1 (not continue from 2)
    const count = await svc.recordFailedAttempt('user-7');
    expect(count).toBe(1);
    expect(await svc.isAccountLocked('user-7')).toBe(false);
  });
});

describe('resetFailureCount', () => {
  test('resets the counter so subsequent attempts start fresh', async () => {
    await svc.recordFailedAttempt('user-8');
    await svc.recordFailedAttempt('user-8');
    await svc.resetFailureCount('user-8');
    const count = await svc.recordFailedAttempt('user-8');
    expect(count).toBe(1);
  });

  test('does not remove an active lock (separate from failure count)', async () => {
    await svc.lockAccount('user-9');
    await svc.resetFailureCount('user-9');
    // Lock should still be active — resetFailureCount only resets the counter
    expect(await svc.isAccountLocked('user-9')).toBe(true);
  });

  test('is safe to call on a user with no recorded failures', async () => {
    await svc.resetFailureCount('user-never-failed');
    const count = await svc.recordFailedAttempt('user-never-failed');
    expect(count).toBe(1);
  });
});

describe('lockout after maxAttempts via recordFailedAttempt', () => {
  test('isAccountLocked is true after explicit lockAccount triggered at maxAttempts', async () => {
    svc = createLockoutService(
      { maxAttempts: 2, lockoutDuration: 60 },
      createMemoryLockoutRepository(),
    );
    const id = 'user-lock-flow';
    const count1 = await svc.recordFailedAttempt(id);
    if (count1 >= 2) await svc.lockAccount(id);
    const count2 = await svc.recordFailedAttempt(id);
    if (count2 >= 2) await svc.lockAccount(id);
    expect(await svc.isAccountLocked(id)).toBe(true);
  });
});
