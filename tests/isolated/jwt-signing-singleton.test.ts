import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import { signToken, verifyToken } from '@auth/lib/jwt';
import { describe, expect, it } from 'bun:test';

const signing = (secret: string | string[]) => ({ secret });

describe('jwt.ts signs from live signing config', () => {
  it('signs and verifies a token using injected signing secret', async () => {
    const secret = 'injected-jwt-secret-at-least-32-chars-long-enough';

    const token = await signToken(
      { sub: 'user-1' },
      undefined,
      DEFAULT_AUTH_CONFIG,
      signing(secret),
    );
    expect(typeof token).toBe('string');

    const payload = await verifyToken(token, DEFAULT_AUTH_CONFIG, signing(secret));
    expect(payload.sub).toBe('user-1');
  });

  it('throws when no signing secret is configured', async () => {
    await expect(signToken({ sub: 'user-1' }, undefined, DEFAULT_AUTH_CONFIG)).rejects.toThrow(
      'No JWT secret configured',
    );
  });

  it('throws when injected secret is shorter than 32 chars', async () => {
    await expect(
      signToken({ sub: 'user-1' }, undefined, DEFAULT_AUTH_CONFIG, signing('tooshort')),
    ).rejects.toThrow('too short');
  });

  it('no process.env fallback — missing signing config throws', async () => {
    // Previously this test verified JWT_SECRET env var fallback.
    // With singleton elimination, secrets flow through SigningConfig only.
    // signToken without a signing config must throw regardless of env state.
    await expect(signToken({ sub: 'user-env' }, undefined, DEFAULT_AUTH_CONFIG)).rejects.toThrow(
      'No JWT secret configured',
    );
  });

  it('uses first element when signing secret is an array', async () => {
    const secrets = [
      'primary-secret-at-least-32-chars-long-first',
      'secondary-secret-long-enough-too',
    ];

    const token = await signToken(
      { sub: 'user-array' },
      undefined,
      DEFAULT_AUTH_CONFIG,
      signing(secrets),
    );
    expect(typeof token).toBe('string');

    const payload = await verifyToken(token, DEFAULT_AUTH_CONFIG, signing(secrets));
    expect(payload.sub).toBe('user-array');
  });
});
