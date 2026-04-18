/**
 * Public API surface importability tests.
 *
 * These tests guard against accidental removal of public exports and verify
 * that the main package entry (@lastshotlabs/slingshot-auth) vs. the testing
 * entry (@lastshotlabs/slingshot-auth/testing) export the right symbols.
 *
 * Failure here means a public API contract has been broken.
 */
import { describe, expect, test } from 'bun:test';

describe('main package exports', () => {
  test('createAuthPlugin is exported', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth');
    expect(typeof mod.createAuthPlugin).toBe('function');
  });

  test('createMemoryAuthAdapter is exported', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth');
    expect(typeof mod.createMemoryAuthAdapter).toBe('function');
  });

  test('createSqliteAuthAdapter is exported', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth');
    expect(typeof mod.createSqliteAuthAdapter).toBe('function');
  });

  test('signToken and verifyToken are exported', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth');
    expect(typeof mod.signToken).toBe('function');
    expect(typeof mod.verifyToken).toBe('function');
  });

  test('getAuthRuntimeFromRequest is exported', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth');
    expect(typeof mod.getAuthRuntimeFromRequest).toBe('function');
  });

  test('session helpers are exported', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth');
    expect(typeof mod.createSession).toBe('function');
    expect(typeof mod.getSession).toBe('function');
    expect(typeof mod.deleteSession).toBe('function');
  });
});

describe('main package — intentionally NOT exported', () => {
  test('deleteUserSessions is NOT exported from main entry (F11 — internal API)', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth');
    // deleteUserSessions bypasses security events and hooks; it was removed from the
    // public API in F11. Callers should use runtime.repos.session directly.
    expect((mod as any).deleteUserSessions).toBeUndefined();
  });

  test('createMemorySessionRepository is NOT exported from main entry (testing-only)', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth');
    expect((mod as any).createMemorySessionRepository).toBeUndefined();
  });

  test('SessionRepository interface does not appear as a runtime value in main entry', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth');
    expect((mod as any).SessionRepository).toBeUndefined();
  });
});

describe('testing entry exports', () => {
  test('createMemoryAuthAdapter is exported from /testing', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth/testing');
    expect(typeof mod.createMemoryAuthAdapter).toBe('function');
  });

  test('createMemorySessionRepository is exported from /testing', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth/testing');
    expect(typeof mod.createMemorySessionRepository).toBe('function');
  });

  test('createAuthRateLimitService is exported from /testing', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth/testing');
    expect(typeof mod.createAuthRateLimitService).toBe('function');
  });

  test('createMemoryAuthRateLimitRepository is exported from /testing', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth/testing');
    expect(typeof mod.createMemoryAuthRateLimitRepository).toBe('function');
  });

  test('createMemoryMfaChallengeRepository is exported from /testing', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth/testing');
    expect(typeof mod.createMemoryMfaChallengeRepository).toBe('function');
  });

  test('createMemorySamlRequestIdRepository is exported from /testing', async () => {
    const mod = await import('@lastshotlabs/slingshot-auth/testing');
    expect(typeof mod.createMemorySamlRequestIdRepository).toBe('function');
  });
});
