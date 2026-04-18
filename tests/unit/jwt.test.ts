import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import { signToken, verifyToken } from '@auth/lib/jwt';
import { describe, expect, test } from 'bun:test';
import type { SigningConfig } from '@lastshotlabs/slingshot-core';

// Signing config passed explicitly — no process.env.JWT_SECRET fallback
const TEST_SIGNING: SigningConfig = {
  secret: 'test-secret-key-must-be-at-least-32-chars!!',
};

describe('signToken', () => {
  test('returns a non-empty JWT string in three-segment format', async () => {
    const token = await signToken(
      { sub: 'user-1', sid: 'session-abc' },
      undefined,
      DEFAULT_AUTH_CONFIG,
      TEST_SIGNING,
    );
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(token.split('.').length).toBe(3);
  });

  test('encodes userId and sessionId into the token', async () => {
    const token = await signToken(
      { sub: 'user-2', sid: 'session-xyz' },
      undefined,
      DEFAULT_AUTH_CONFIG,
      TEST_SIGNING,
    );
    const payload = await verifyToken(token, DEFAULT_AUTH_CONFIG, TEST_SIGNING);
    expect(payload.sub).toBe('user-2');
    expect(payload.sid).toBe('session-xyz');
  });

  test('accepts a custom expirySeconds and still produces a valid JWT', async () => {
    const token = await signToken(
      { sub: 'user-3', sid: 'session-short' },
      3600,
      DEFAULT_AUTH_CONFIG,
      TEST_SIGNING,
    );
    expect(token.split('.').length).toBe(3);
    const payload = await verifyToken(token, DEFAULT_AUTH_CONFIG, TEST_SIGNING);
    expect(payload.sub).toBe('user-3');
  });
});

describe('verifyToken', () => {
  test('verifies a freshly-signed token and returns sub + sid claims', async () => {
    const token = await signToken(
      { sub: 'user-4', sid: 'session-123' },
      undefined,
      DEFAULT_AUTH_CONFIG,
      TEST_SIGNING,
    );
    const payload = await verifyToken(token, DEFAULT_AUTH_CONFIG, TEST_SIGNING);
    expect(payload.sub).toBe('user-4');
    expect(payload.sid).toBe('session-123');
  });

  test('rejects a corrupted token', async () => {
    await expect(
      verifyToken('not.a.valid.jwt', DEFAULT_AUTH_CONFIG, TEST_SIGNING),
    ).rejects.toThrow();
  });

  test('rejects an empty string', async () => {
    await expect(verifyToken('', DEFAULT_AUTH_CONFIG, TEST_SIGNING)).rejects.toThrow();
  });

  test('rejects a token with a tampered payload segment', async () => {
    const token = await signToken(
      { sub: 'user-5', sid: 'session-tamper' },
      undefined,
      DEFAULT_AUTH_CONFIG,
      TEST_SIGNING,
    );
    const parts = token.split('.');
    // Replace payload segment with a different base64url-encoded JSON
    const fakePayload = Buffer.from(JSON.stringify({ sub: 'attacker', sid: 'evil' })).toString(
      'base64url',
    );
    const tampered = `${parts[0]}.${fakePayload}.${parts[2]}`;
    await expect(verifyToken(tampered, DEFAULT_AUTH_CONFIG, TEST_SIGNING)).rejects.toThrow();
  });
});
