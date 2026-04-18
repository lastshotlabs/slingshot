import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthResolvedConfig } from '@auth/config/authConfig';
import { signToken, verifyToken } from '@auth/lib/jwt';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { SigningConfig } from '@lastshotlabs/slingshot-core';

const TEST_SIGNING: SigningConfig = { secret: 'test-secret-key-must-be-at-least-32-chars!!' };

let config: AuthResolvedConfig;

beforeEach(() => {
  config = { ...DEFAULT_AUTH_CONFIG };
});

describe('JWT claims — iat', () => {
  test('iat is always present in tokens', async () => {
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(typeof payload.iat).toBe('number');
    expect(payload.iat).toBeGreaterThan(0);
  });

  test('iat is a recent timestamp', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const after = Math.floor(Date.now() / 1000);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after + 1);
  });
});

describe('JWT claims — iss (issuer)', () => {
  test('iss is included when configured', async () => {
    config = { ...config, jwt: { issuer: 'https://auth.example.com' } };
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(payload.iss).toBe('https://auth.example.com');
  });

  test('iss is absent when not configured', async () => {
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(payload.iss).toBeUndefined();
  });

  test('wrong issuer fails verification', async () => {
    const signConfig = { ...config, jwt: { issuer: 'https://auth.example.com' } };
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, signConfig, TEST_SIGNING);
    const verifyConfig = { ...config, jwt: { issuer: 'https://other.example.com' } };
    await expect(verifyToken(token, verifyConfig, TEST_SIGNING)).rejects.toThrow();
  });
});

describe('JWT claims — aud (audience)', () => {
  test('aud is included when configured', async () => {
    config = { ...config, jwt: { audience: 'my-api' } };
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(payload.aud).toBe('my-api');
  });

  test('aud array is included when configured', async () => {
    config = { ...config, jwt: { audience: ['api-a', 'api-b'] } };
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(Array.isArray(payload.aud)).toBe(true);
    expect(payload.aud).toContain('api-a');
  });

  test('aud is absent when not configured', async () => {
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(payload.aud).toBeUndefined();
  });

  test('wrong audience fails verification', async () => {
    const signConfig = { ...config, jwt: { audience: 'api-a' } };
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, signConfig, TEST_SIGNING);
    const verifyConfig = { ...config, jwt: { audience: 'api-b' } };
    await expect(verifyToken(token, verifyConfig, TEST_SIGNING)).rejects.toThrow();
  });
});

describe('JWT claims — iss + aud together', () => {
  test('both claims present when both configured', async () => {
    config = { ...config, jwt: { issuer: 'https://auth.example.com', audience: 'my-api' } };
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(payload.iss).toBe('https://auth.example.com');
    expect(payload.aud).toBe('my-api');
    expect(typeof payload.iat).toBe('number');
  });
});
