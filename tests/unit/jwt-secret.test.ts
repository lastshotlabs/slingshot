/**
 * Tests the JWT secret validation error path.
 *
 * Tests pass signing config explicitly — no process.env.JWT_SECRET manipulation.
 * This is the singleton-free pattern: all config flows through parameters.
 */
import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import { signToken, verifyToken } from '@auth/lib/jwt';
import { describe, expect, test } from 'bun:test';
import type { SigningConfig } from '@lastshotlabs/slingshot-core';

describe('JWT secret validation', () => {
  test('signToken throws when no signing secret is configured', async () => {
    // No signing config passed → getSigningSecret returns null
    await expect(
      signToken({ sub: 'user', sid: 'session' }, undefined, DEFAULT_AUTH_CONFIG),
    ).rejects.toThrow('[security] No JWT secret configured');
  });

  test('signToken throws when signing secret is shorter than 32 characters', async () => {
    const shortSigning: SigningConfig = { secret: 'short' };
    await expect(
      signToken({ sub: 'user', sid: 'session' }, undefined, DEFAULT_AUTH_CONFIG, shortSigning),
    ).rejects.toThrow('[security] JWT secret is too short');
  });

  test('signToken throws when signing secret is exactly 31 characters (boundary)', async () => {
    const boundarySigning: SigningConfig = { secret: 'a'.repeat(31) };
    await expect(
      signToken({ sub: 'user', sid: 'session' }, undefined, DEFAULT_AUTH_CONFIG, boundarySigning),
    ).rejects.toThrow('[security]');
  });

  test('verifyToken throws when no signing secret is configured', async () => {
    // No signing config passed → getSigningSecret returns null
    await expect(verifyToken('any.token.here', DEFAULT_AUTH_CONFIG)).rejects.toThrow('[security]');
  });
});
