import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { beforeEach, describe, expect, test } from 'bun:test';
import { sha256 } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// These tests exercise consumeRecoveryCode on the memory adapter (which is
// what createTestApp uses). They verify:
//   1. A valid hashed code is found and removed (returns true).
//   2. A second call with the same code returns false (already consumed).
//   3. An unknown code returns false without touching the store.
//   4. Simulated concurrent double-consumption (two sequential calls that
//      would both have succeeded under the old get+remove pattern) only
//      succeeds once under the new atomic API.
// ---------------------------------------------------------------------------

let adapter: ReturnType<typeof createMemoryAuthAdapter>;

beforeEach(async () => {
  await createTestApp(
    {},
    {
      auth: {
        enabled: true,
        mfa: { challengeTtlSeconds: 300 },
      },
    },
  );
  adapter = createMemoryAuthAdapter();
});

async function createUser(email = 'test@example.com'): Promise<string> {
  const user = await adapter.create(email, await Bun.password.hash('password123!'));
  return user.id;
}

async function seedRecoveryCodes(userId: string, plainCodes: string[]): Promise<string[]> {
  const hashed = plainCodes.map(c => sha256(c.toUpperCase()));
  await adapter.setRecoveryCodes!(userId, hashed);
  return hashed;
}

describe('consumeRecoveryCode — memory adapter', () => {
  test('returns true and removes the code on first use', async () => {
    const userId = await createUser();
    const plain = ['ABCD1234', 'EFGH5678'];
    const hashed = await seedRecoveryCodes(userId, plain);

    const result = await adapter.consumeRecoveryCode(userId, hashed[0]);
    expect(result).toBe(true);

    // The code must be gone from the store now
    const remaining = await adapter.getRecoveryCodes!(userId);
    expect(remaining).not.toContain(hashed[0]);
    expect(remaining).toContain(hashed[1]);
  });

  test('returns false on second call with same code (already consumed)', async () => {
    const userId = await createUser();
    const plain = ['ABCD1234'];
    const hashed = await seedRecoveryCodes(userId, plain);

    const first = await adapter.consumeRecoveryCode(userId, hashed[0]);
    expect(first).toBe(true);

    const second = await adapter.consumeRecoveryCode(userId, hashed[0]);
    expect(second).toBe(false);
  });

  test('returns false for an unknown / never-stored code', async () => {
    const userId = await createUser();
    await seedRecoveryCodes(userId, ['ABCD1234']);

    const result = await adapter.consumeRecoveryCode(userId, sha256('ZZZZZZZZ'));
    expect(result).toBe(false);
  });

  test('returns false for a non-existent user', async () => {
    const result = await adapter.consumeRecoveryCode('non-existent-user-id', sha256('ABCD1234'));
    expect(result).toBe(false);
  });

  test('simulated concurrent double-consumption: only one succeeds', async () => {
    // In single-threaded Bun the memory adapter is inherently race-free because
    // consumeRecoveryCode does no async work between the read and the splice.
    // Two sequential calls model the outcome that would occur in a real race:
    // one must win and one must lose.
    const userId = await createUser();
    const plain = ['ABCD1234'];
    const hashed = await seedRecoveryCodes(userId, plain);

    // Fire both without awaiting (they queue microtasks but both enter synchronously)
    const [r1, r2] = await Promise.all([
      adapter.consumeRecoveryCode(userId, hashed[0]),
      adapter.consumeRecoveryCode(userId, hashed[0]),
    ]);

    // Exactly one should succeed
    const successes = [r1, r2].filter(Boolean).length;
    expect(successes).toBe(1);

    // Code must be fully consumed
    const remaining = await adapter.getRecoveryCodes!(userId);
    expect(remaining).toHaveLength(0);
  });
});
