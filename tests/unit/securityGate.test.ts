/**
 * Unit tests for createSecurityGate.
 *
 * The SecurityGate composes three independent security layers:
 *   1. Credential stuffing detection
 *   2. Per-identifier rate limiting
 *   3. Account lockout
 *
 * Tests each path through preAuthCheck, lockoutCheck,
 * recordLoginFailure, and recordLoginSuccess using mock services.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { LockoutService } from '../../packages/slingshot-auth/src/lib/accountLockout';
import type {
  AuthRateLimitService,
  LimitOpts,
} from '../../packages/slingshot-auth/src/lib/authRateLimit';
import type { CredentialStuffingService } from '../../packages/slingshot-auth/src/lib/credentialStuffing';
import { createSecurityGate } from '../../packages/slingshot-auth/src/lib/securityGate';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRateLimit(isLimited = false): AuthRateLimitService {
  return {
    isLimited: mock(async () => isLimited),
    trackAttempt: mock(async () => {}),
    bustAuthLimit: mock(async () => {}),
  } as unknown as AuthRateLimitService;
}

function makeCredentialStuffing(blocked = false): CredentialStuffingService {
  return {
    isStuffingBlocked: mock(async () => blocked),
    trackFailedLogin: mock(async () => false),
  } as unknown as CredentialStuffingService;
}

function makeLockout(locked = false, duration = 300): LockoutService {
  return {
    isAccountLocked: mock(async () => locked),
    config: { lockoutDuration: duration },
  } as unknown as LockoutService;
}

const loginOpts: LimitOpts = { windowMs: 60_000, max: 5 };

// ---------------------------------------------------------------------------
// preAuthCheck — credential stuffing blocked
// ---------------------------------------------------------------------------

describe('SecurityGate.preAuthCheck — credential stuffing', () => {
  test('returns allowed:false with reason credential_stuffing when stuffing is blocked', async () => {
    const gate = createSecurityGate(
      makeRateLimit(false),
      () => makeCredentialStuffing(true),
      () => null,
      loginOpts,
    );
    const result = await gate.preAuthCheck('1.2.3.4', 'user@example.com');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('credential_stuffing');
  });

  test('skips stuffing check when service is null', async () => {
    const gate = createSecurityGate(
      makeRateLimit(false),
      () => null,
      () => null,
      loginOpts,
    );
    const result = await gate.preAuthCheck('1.2.3.4', 'user@example.com');
    expect(result.allowed).toBe(true);
  });

  test('rate limit is NOT checked if stuffing already blocks', async () => {
    const rateLimit = makeRateLimit(true); // would block
    const gate = createSecurityGate(
      rateLimit,
      () => makeCredentialStuffing(true),
      () => null,
      loginOpts,
    );
    await gate.preAuthCheck('1.2.3.4', 'user@example.com');
    expect(rateLimit.isLimited).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// preAuthCheck — rate limit
// ---------------------------------------------------------------------------

describe('SecurityGate.preAuthCheck — rate limiting', () => {
  test('returns allowed:false with reason rate_limited when rate limit exceeded', async () => {
    const gate = createSecurityGate(
      makeRateLimit(true),
      () => null,
      () => null,
      loginOpts,
    );
    const result = await gate.preAuthCheck('1.2.3.4', 'user@example.com');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('rate_limited');
  });

  test('returns allowed:true when neither stuffing nor rate limit blocks', async () => {
    const gate = createSecurityGate(
      makeRateLimit(false),
      () => null,
      () => null,
      loginOpts,
    );
    const result = await gate.preAuthCheck('1.2.3.4', 'user@example.com');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('rate limit key includes identifier (login:identifier)', async () => {
    const rateLimit = makeRateLimit(false);
    const gate = createSecurityGate(
      rateLimit,
      () => null,
      () => null,
      loginOpts,
    );
    await gate.preAuthCheck('1.2.3.4', 'test@example.com');
    const [key] = (rateLimit.isLimited as ReturnType<typeof mock>).mock.calls[0];
    expect(key).toBe('login:test@example.com');
  });
});

// ---------------------------------------------------------------------------
// lockoutCheck
// ---------------------------------------------------------------------------

describe('SecurityGate.lockoutCheck', () => {
  test('returns allowed:true when lockout service is null', async () => {
    const gate = createSecurityGate(
      makeRateLimit(),
      () => null,
      () => null,
      loginOpts,
    );
    const result = await gate.lockoutCheck('user-1');
    expect(result.allowed).toBe(true);
  });

  test('returns allowed:true when account is not locked', async () => {
    const gate = createSecurityGate(
      makeRateLimit(),
      () => null,
      () => makeLockout(false),
      loginOpts,
    );
    const result = await gate.lockoutCheck('user-1');
    expect(result.allowed).toBe(true);
  });

  test('returns allowed:false with reason account_locked when locked', async () => {
    const gate = createSecurityGate(
      makeRateLimit(),
      () => null,
      () => makeLockout(true, 600),
      loginOpts,
    );
    const result = await gate.lockoutCheck('user-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('account_locked');
  });

  test('retryAfterSeconds equals lockout config duration', async () => {
    const gate = createSecurityGate(
      makeRateLimit(),
      () => null,
      () => makeLockout(true, 900),
      loginOpts,
    );
    const result = await gate.lockoutCheck('user-1');
    expect(result.retryAfterSeconds).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// recordLoginFailure
// ---------------------------------------------------------------------------

describe('SecurityGate.recordLoginFailure', () => {
  test('increments rate limit for the identifier', async () => {
    const rateLimit = makeRateLimit();
    const gate = createSecurityGate(
      rateLimit,
      () => null,
      () => null,
      loginOpts,
    );
    await gate.recordLoginFailure('1.2.3.4', 'user@example.com');
    expect(rateLimit.trackAttempt).toHaveBeenCalledTimes(1);
    const [key] = (rateLimit.trackAttempt as ReturnType<typeof mock>).mock.calls[0];
    expect(key).toBe('login:user@example.com');
  });

  test('tracks failed login in credential stuffing service', async () => {
    const stuffing = makeCredentialStuffing();
    const gate = createSecurityGate(
      makeRateLimit(),
      () => stuffing,
      () => null,
      loginOpts,
    );
    await gate.recordLoginFailure('5.6.7.8', 'user@example.com');
    expect(stuffing.trackFailedLogin).toHaveBeenCalledWith('5.6.7.8', 'user@example.com');
  });

  test('returns stuffingNowBlocked:false when stuffing service is null', async () => {
    const gate = createSecurityGate(
      makeRateLimit(),
      () => null,
      () => null,
      loginOpts,
    );
    const result = await gate.recordLoginFailure('1.2.3.4', 'user@example.com');
    expect(result.stuffingNowBlocked).toBe(false);
  });

  test('returns stuffingNowBlocked:true when stuffing service returns true', async () => {
    const stuffing: CredentialStuffingService = {
      isStuffingBlocked: mock(async () => false),
      trackFailedLogin: mock(async () => true),
    } as unknown as CredentialStuffingService;

    const gate = createSecurityGate(
      makeRateLimit(),
      () => stuffing,
      () => null,
      loginOpts,
    );
    const result = await gate.recordLoginFailure('1.2.3.4', 'user@example.com');
    expect(result.stuffingNowBlocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordLoginSuccess
// ---------------------------------------------------------------------------

describe('SecurityGate.recordLoginSuccess', () => {
  test('busts the auth rate limit for the identifier', async () => {
    const rateLimit = makeRateLimit();
    const gate = createSecurityGate(
      rateLimit,
      () => null,
      () => null,
      loginOpts,
    );
    await gate.recordLoginSuccess('user@example.com');
    expect(rateLimit.bustAuthLimit).toHaveBeenCalledTimes(1);
    const [key] = (rateLimit.bustAuthLimit as ReturnType<typeof mock>).mock.calls[0];
    expect(key).toBe('login:user@example.com');
  });
});
