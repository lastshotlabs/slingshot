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

describe('signToken — object form', () => {
  test('signs with sub + sid', async () => {
    const token = await signToken({ sub: 'user1', sid: 'sess1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(payload.sub).toBe('user1');
    expect(payload.sid).toBe('sess1');
  });

  test('signs M2M token (scope, no sid)', async () => {
    const token = await signToken(
      { sub: 'client1', scope: 'read:data' },
      undefined,
      config,
      TEST_SIGNING,
    );
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(payload.sub).toBe('client1');
    expect(payload.scope).toBe('read:data');
    expect(payload.sid).toBeUndefined();
  });
});

describe('iss/aud/iat claims', () => {
  test('iat is always included', async () => {
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(typeof payload.iat).toBe('number');
  });

  test('iss and aud included when configured', async () => {
    config = { ...config, jwt: { issuer: 'https://example.com', audience: 'my-app' } };
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config, TEST_SIGNING);
    const payload = await verifyToken(token, config, TEST_SIGNING);
    expect(payload.iss).toBe('https://example.com');
    expect(payload.aud).toBe('my-app');
  });

  test('wrong issuer fails verification', async () => {
    const signConfig = { ...config, jwt: { issuer: 'https://example.com' } };
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, signConfig, TEST_SIGNING);
    const verifyConfig = { ...config, jwt: { issuer: 'https://other.com' } };
    await expect(verifyToken(token, verifyConfig, TEST_SIGNING)).rejects.toThrow();
  });

  test('wrong audience fails verification', async () => {
    const signConfig = { ...config, jwt: { audience: 'app-a' } };
    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, signConfig, TEST_SIGNING);
    const verifyConfig = { ...config, jwt: { audience: 'app-b' } };
    await expect(verifyToken(token, verifyConfig, TEST_SIGNING)).rejects.toThrow();
  });
});
