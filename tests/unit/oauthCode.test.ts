import {
  type OAuthCodeRepository,
  consumeOAuthCode,
  createMemoryOAuthCodeRepository,
  createSqliteOAuthCodeRepository,
  storeOAuthCode,
} from '@auth/lib/oauthCode';
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'crypto';
import type { DataEncryptionKey } from '@lastshotlabs/slingshot-core';

const payload = {
  token: 'jwt-token-abc',
  userId: 'user-1',
  email: 'test@example.com',
};

// ---------------------------------------------------------------------------
// Memory backend
// ---------------------------------------------------------------------------

describe('oauthCode — memory backend', () => {
  let repo: OAuthCodeRepository;

  beforeEach(() => {
    repo = createMemoryOAuthCodeRepository();
  });

  test('stores a code and returns the raw code string', async () => {
    const code = await storeOAuthCode(repo, payload, []);
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(0);
  });

  test('consumes the code and returns the payload', async () => {
    const code = await storeOAuthCode(repo, payload, []);
    const result = await consumeOAuthCode(repo, code, []);
    expect(result).not.toBeNull();
    expect(result!.token).toBe(payload.token);
    expect(result!.userId).toBe(payload.userId);
    expect(result!.email).toBe(payload.email);
  });

  test('second consume returns null (single-use)', async () => {
    const code = await storeOAuthCode(repo, payload, []);
    await consumeOAuthCode(repo, code, []);
    expect(await consumeOAuthCode(repo, code, [])).toBeNull();
  });

  test('returns null for an unknown code', async () => {
    expect(await consumeOAuthCode(repo, 'nonexistent-code', [])).toBeNull();
  });

  test('stores payload without optional fields', async () => {
    const code = await storeOAuthCode(repo, { token: 't', userId: 'u' }, []);
    const result = await consumeOAuthCode(repo, code, []);
    expect(result!.email).toBeUndefined();
    expect(result!.refreshToken).toBeUndefined();
  });

  test('two different codes are independent', async () => {
    const code1 = await storeOAuthCode(repo, { token: 't1', userId: 'u1' }, []);
    const code2 = await storeOAuthCode(repo, { token: 't2', userId: 'u2' }, []);
    expect(code1).not.toBe(code2);
    expect((await consumeOAuthCode(repo, code1, []))!.userId).toBe('u1');
    expect((await consumeOAuthCode(repo, code2, []))!.userId).toBe('u2');
  });
});

// ---------------------------------------------------------------------------
// SQLite backend
// ---------------------------------------------------------------------------

describe('oauthCode — sqlite backend', () => {
  let repo: OAuthCodeRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    repo = createSqliteOAuthCodeRepository(db);
  });

  test('stores a code and returns the raw code string', async () => {
    const code = await storeOAuthCode(repo, payload, []);
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(0);
  });

  test('consumes the code and returns the payload', async () => {
    const code = await storeOAuthCode(repo, payload, []);
    const result = await consumeOAuthCode(repo, code, []);
    expect(result).not.toBeNull();
    expect(result!.token).toBe(payload.token);
    expect(result!.userId).toBe(payload.userId);
    expect(result!.email).toBe(payload.email);
  });

  test('second consume returns null (single-use)', async () => {
    const code = await storeOAuthCode(repo, payload, []);
    await consumeOAuthCode(repo, code, []);
    expect(await consumeOAuthCode(repo, code, [])).toBeNull();
  });

  test('returns null for an unknown code', async () => {
    expect(await consumeOAuthCode(repo, 'nonexistent-code', [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Encryption at rest (B-6)
// ---------------------------------------------------------------------------

// Generate a valid 32-byte test key
const testKey = randomBytes(32);
const testDeks: DataEncryptionKey[] = [{ keyId: 'key1', key: testKey }];

describe('oauthCode — encryption at rest', () => {
  let repo: OAuthCodeRepository;

  beforeEach(() => {
    repo = createMemoryOAuthCodeRepository();
  });

  test('round-trip with encryption enabled', async () => {
    const p = {
      token: 'jwt-token-encrypted',
      userId: 'user-enc',
      email: 'enc@example.com',
      refreshToken: 'refresh-token-encrypted',
    };
    const code = await storeOAuthCode(repo, p, testDeks);
    const result = await consumeOAuthCode(repo, code, testDeks);
    expect(result).not.toBeNull();
    expect(result!.token).toBe(p.token);
    expect(result!.userId).toBe(p.userId);
    expect(result!.email).toBe(p.email);
    expect(result!.refreshToken).toBe(p.refreshToken);
  });

  test('without encryption, tokens stored as plaintext', async () => {
    const p = { token: 'plaintext-jwt', userId: 'user-plain' };
    const code = await storeOAuthCode(repo, p, []);
    const result = await consumeOAuthCode(repo, code, []);
    expect(result).not.toBeNull();
    expect(result!.token).toBe('plaintext-jwt');
    expect(result!.userId).toBe('user-plain');
  });

  test('backward compat: plaintext code consumed after encryption enabled', async () => {
    // Store without encryption
    const p = { token: 'old-plaintext-jwt', userId: 'user-compat', refreshToken: 'old-refresh' };
    const code = await storeOAuthCode(repo, p, []);

    // Now consume with encryption keys — should still work because isEncryptedField
    // returns false for plaintext values (no 4-dot format)
    const result = await consumeOAuthCode(repo, code, testDeks);
    expect(result).not.toBeNull();
    expect(result!.token).toBe(p.token);
    expect(result!.userId).toBe(p.userId);
    expect(result!.refreshToken).toBe(p.refreshToken);
  });
});
