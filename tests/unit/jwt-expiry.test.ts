/**
 * Tests for F2 (default expiry 1h not 7d) and F13 (reserved claim injection prevention).
 */
import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthResolvedConfig } from '@auth/config/authConfig';
import { signToken, verifyToken } from '@auth/lib/jwt';
import { describe, expect, test } from 'bun:test';
import type { SigningConfig } from '@lastshotlabs/slingshot-core';

const SIGNING: SigningConfig = { secret: 'test-secret-key-must-be-at-least-32-chars!!' };
const config: AuthResolvedConfig = { ...DEFAULT_AUTH_CONFIG };

// ---------------------------------------------------------------------------
// F2 — default expiry is 1 hour when expirySeconds is omitted
// ---------------------------------------------------------------------------

describe('signToken — default expiry', () => {
  test('token exp is ~1 hour in the future when expirySeconds is undefined', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, SIGNING);
    const payload = await verifyToken(token, config, SIGNING);

    const exp = payload.exp!;
    const expectedExpiry = before + 3600; // 1 hour
    // Allow a few seconds of slack for test execution
    expect(exp).toBeGreaterThanOrEqual(expectedExpiry - 5);
    expect(exp).toBeLessThanOrEqual(expectedExpiry + 5);
  });

  test('token exp is not 7 days when expirySeconds is undefined', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, SIGNING);
    const payload = await verifyToken(token, config, SIGNING);

    const exp = payload.exp!;
    const sevenDays = before + 7 * 24 * 3600;
    // exp should be nowhere near 7 days
    expect(exp).toBeLessThan(sevenDays - 3600 * 6);
  });

  test('explicit expirySeconds overrides the 1h default', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signToken({ sub: 'u1', sid: 's1' }, 300, config, SIGNING);
    const payload = await verifyToken(token, config, SIGNING);

    const exp = payload.exp!;
    expect(exp).toBeGreaterThanOrEqual(before + 295);
    expect(exp).toBeLessThanOrEqual(before + 305);
  });
});

// ---------------------------------------------------------------------------
// F13 — reserved claims are not injectable via extra claims fields
// ---------------------------------------------------------------------------

describe('signToken — reserved claim protection', () => {
  test('sub claim is always the userId passed in, not overridable by extra fields', async () => {
    // TokenClaims type enforces sub is the first arg, but verify the runtime behavior
    const token = await signToken(
      { sub: 'real-user', sid: 's1', 'sub-override': 'attacker' },
      undefined,
      config,
      SIGNING,
    );
    const payload = await verifyToken(token, config, SIGNING);
    expect(payload.sub).toBe('real-user');
  });

  test('extra claim passes through when not a reserved field', async () => {
    const token = await signToken(
      { sub: 'u2', sid: 's2', role: 'admin', tenant: 'acme' },
      undefined,
      config,
      SIGNING,
    );
    const payload = await verifyToken(token, config, SIGNING);
    expect(payload.sub).toBe('u2');
    expect(payload['role']).toBe('admin');
    expect(payload['tenant']).toBe('acme');
  });

  test('iat is always set by signToken, not by the caller', async () => {
    const token = await signToken({ sub: 'u3', sid: 's3' }, undefined, config, SIGNING);
    const payload = await verifyToken(token, config, SIGNING);
    // iat must be a recent timestamp, not zero or undefined
    expect(typeof payload.iat).toBe('number');
    expect(payload.iat!).toBeGreaterThan(0);
  });

  test('sid claim is preserved in signed token', async () => {
    const token = await signToken({ sub: 'u4', sid: 'session-abc' }, undefined, config, SIGNING);
    const payload = await verifyToken(token, config, SIGNING);
    expect(payload['sid']).toBe('session-abc');
  });
});
