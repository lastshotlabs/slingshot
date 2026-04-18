import { describe, expect, test } from 'bun:test';
import { createMemoryMagicLinkRepository } from '../../src/lib/magicLink';
import { consumeMagicLinkToken, createMagicLinkToken } from '../../src/lib/magicLink';

describe('magic link token lifecycle', () => {
  test('valid token returns the userId on first consume', async () => {
    const repo = createMemoryMagicLinkRepository();
    const token = await createMagicLinkToken(repo, 'user-42');

    const userId = await consumeMagicLinkToken(repo, token);
    expect(userId).toBe('user-42');
  });

  test('token is single-use — second consume returns null', async () => {
    const repo = createMemoryMagicLinkRepository();
    const token = await createMagicLinkToken(repo, 'user-42');

    await consumeMagicLinkToken(repo, token); // first use
    const second = await consumeMagicLinkToken(repo, token); // reuse attempt
    expect(second).toBeNull();
  });

  test('an unknown or tampered token returns null', async () => {
    const repo = createMemoryMagicLinkRepository();
    await createMagicLinkToken(repo, 'user-42'); // seed a real token

    // A completely different token should not resolve
    const result = await consumeMagicLinkToken(repo, 'not-a-real-token');
    expect(result).toBeNull();
  });
});
