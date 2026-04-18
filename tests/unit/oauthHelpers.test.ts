import { createMemoryOAuthStateStore } from '@auth/lib/oauth';
import {
  type OAuthCodeRepository,
  consumeOAuthCode,
  createMemoryOAuthCodeRepository,
  storeOAuthCode,
} from '@auth/lib/oauthCode';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

const oauthStateStore = createMemoryOAuthStateStore();
let app: any;
let repo: OAuthCodeRepository;

beforeEach(async () => {
  app = await createTestApp();
  repo = createMemoryOAuthCodeRepository();
});
// ---------------------------------------------------------------------------
// OAuth State
// ---------------------------------------------------------------------------

describe('storeOAuthState + consumeOAuthState', () => {
  test('round-trip stores and retrieves state', async () => {
    await oauthStateStore.store('state-1');
    const result = await oauthStateStore.consume('state-1');
    expect(result).not.toBeNull();
  });

  test('consuming same state twice returns null', async () => {
    await oauthStateStore.store('state-2');
    await oauthStateStore.consume('state-2');
    const result = await oauthStateStore.consume('state-2');
    expect(result).toBeNull();
  });

  test('preserves codeVerifier', async () => {
    await oauthStateStore.store('state-3', 'verifier-abc');
    const result = await oauthStateStore.consume('state-3');
    expect(result!.codeVerifier).toBe('verifier-abc');
  });

  test('preserves linkUserId', async () => {
    await oauthStateStore.store('state-4', undefined, 'user-xyz');
    const result = await oauthStateStore.consume('state-4');
    expect(result!.linkUserId).toBe('user-xyz');
  });

  test('returns null for non-existent state', async () => {
    const result = await oauthStateStore.consume('nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth Code
// ---------------------------------------------------------------------------

describe('storeOAuthCode + consumeOAuthCode', () => {
  test('round-trip stores and retrieves code', async () => {
    const code = await storeOAuthCode(repo, { token: 'jwt-token', userId: 'u1' }, []);
    expect(typeof code).toBe('string');
    const result = await consumeOAuthCode(repo, code, []);
    expect(result).not.toBeNull();
    expect(result!.token).toBe('jwt-token');
    expect(result!.userId).toBe('u1');
  });

  test('consuming same code twice returns null', async () => {
    const code = await storeOAuthCode(repo, { token: 'jwt', userId: 'u2' }, []);
    await consumeOAuthCode(repo, code, []);
    const result = await consumeOAuthCode(repo, code, []);
    expect(result).toBeNull();
  });

  test('preserves full payload', async () => {
    const code = await storeOAuthCode(
      repo,
      {
        token: 't',
        userId: 'u3',
        email: 'test@example.com',
        refreshToken: 'rt-123',
      },
      [],
    );
    const result = await consumeOAuthCode(repo, code, []);
    expect(result!.email).toBe('test@example.com');
    expect(result!.refreshToken).toBe('rt-123');
  });
});
