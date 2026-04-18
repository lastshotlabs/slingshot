import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import {
  createMemoryVerificationTokenRepository,
  createVerificationToken,
  deleteVerificationToken,
  getVerificationToken,
} from '@auth/lib/emailVerification';
import { beforeEach, describe, expect, test } from 'bun:test';

let repo: ReturnType<typeof createMemoryVerificationTokenRepository>;
let config: AuthResolvedConfig;

beforeEach(() => {
  repo = createMemoryVerificationTokenRepository();
  config = { ...DEFAULT_AUTH_CONFIG, emailVerification: { tokenExpiry: 300 } };
});

// ---------------------------------------------------------------------------
// createVerificationToken + getVerificationToken
// ---------------------------------------------------------------------------

describe('createVerificationToken + getVerificationToken', () => {
  test('creates a token and retrieves its data', async () => {
    const token = await createVerificationToken(repo, 'user1', 'user@example.com', config);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const data = await getVerificationToken(repo, token);
    expect(data).not.toBeNull();
    expect(data!.userId).toBe('user1');
    expect(data!.email).toBe('user@example.com');
  });

  test('returns null for non-existent token', async () => {
    expect(await getVerificationToken(repo, 'nonexistent')).toBeNull();
  });

  test('returns null for expired token', async () => {
    config = { ...config, emailVerification: { tokenExpiry: 1 } };
    const token = await createVerificationToken(repo, 'user1', 'user@example.com', config);
    await Bun.sleep(1100);
    expect(await getVerificationToken(repo, token)).toBeNull();
    config = { ...config, emailVerification: { tokenExpiry: 300 } };
  });
});

// ---------------------------------------------------------------------------
// deleteVerificationToken
// ---------------------------------------------------------------------------

describe('deleteVerificationToken', () => {
  test('deletes token so subsequent get returns null', async () => {
    const token = await createVerificationToken(repo, 'user1', 'user@example.com', config);
    await deleteVerificationToken(repo, token);
    expect(await getVerificationToken(repo, token)).toBeNull();
  });

  test('is safe to call on non-existent token', async () => {
    await deleteVerificationToken(repo, 'nonexistent'); // should not throw
  });
});
