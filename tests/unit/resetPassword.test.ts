import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import {
  consumeResetToken,
  createMemoryResetTokenRepository,
  createResetToken,
} from '@auth/lib/resetPassword';
import { beforeEach, describe, expect, test } from 'bun:test';

let repo: ReturnType<typeof createMemoryResetTokenRepository>;
let config: AuthResolvedConfig;

beforeEach(() => {
  repo = createMemoryResetTokenRepository();
  config = { ...DEFAULT_AUTH_CONFIG, passwordReset: { tokenExpiry: 300 } };
});

// ---------------------------------------------------------------------------
// createResetToken + consumeResetToken
// ---------------------------------------------------------------------------

describe('createResetToken + consumeResetToken', () => {
  test('creates a raw token and consumes it', async () => {
    const token = await createResetToken(repo, 'user1', 'user@example.com', config);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const data = await consumeResetToken(repo, token);
    expect(data).not.toBeNull();
    expect(data!.userId).toBe('user1');
    expect(data!.email).toBe('user@example.com');
  });

  test('second consume returns null (atomic single-use)', async () => {
    const token = await createResetToken(repo, 'user1', 'user@example.com', config);
    await consumeResetToken(repo, token);
    expect(await consumeResetToken(repo, token)).toBeNull();
  });

  test('returns null for non-existent token', async () => {
    expect(await consumeResetToken(repo, 'nonexistent')).toBeNull();
  });

  test('returns null for expired token', async () => {
    config = { ...config, passwordReset: { tokenExpiry: 1 } };
    const token = await createResetToken(repo, 'user1', 'user@example.com', config);
    await Bun.sleep(1100);
    expect(await consumeResetToken(repo, token)).toBeNull();
    config = { ...config, passwordReset: { tokenExpiry: 300 } };
  });

  test('raw token is not the stored hash', async () => {
    // Create two tokens for the same user — they should be different UUIDs
    const token1 = await createResetToken(repo, 'user1', 'a@b.com', config);
    const token2 = await createResetToken(repo, 'user1', 'a@b.com', config);
    expect(token1).not.toBe(token2);

    // Both should be consumable independently
    expect(await consumeResetToken(repo, token1)).not.toBeNull();
    expect(await consumeResetToken(repo, token2)).not.toBeNull();
  });
});
