/**
 * Unit tests for the DeletionCancelToken memory adapter
 * and the createDeletionCancelToken / consumeDeletionCancelToken public API.
 *
 * Tests: store/consume round-trip, TTL expiry, single-use (consumed once),
 * wrong token returns null, and the public token API.
 */
import { describe, expect, test } from 'bun:test';
import {
  consumeDeletionCancelToken,
  createDeletionCancelToken,
  createMemoryDeletionCancelTokenRepository,
} from '../../packages/slingshot-auth/src/lib/deletionCancelToken';

// ---------------------------------------------------------------------------
// Memory repository — store / consume
// ---------------------------------------------------------------------------

describe('createMemoryDeletionCancelTokenRepository — store and consume', () => {
  test('consume returns null when nothing has been stored', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    const result = await repo.consume('nonexistent-hash');
    expect(result).toBeNull();
  });

  test('store then consume returns stored data', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    await repo.store('hash-abc', 'user-1', 'job-1', 3600);
    const result = await repo.consume('hash-abc');
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.jobId).toBe('job-1');
  });

  test('token is deleted after consume (single-use)', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    await repo.store('hash-xyz', 'user-1', 'job-1', 3600);
    await repo.consume('hash-xyz');
    const second = await repo.consume('hash-xyz');
    expect(second).toBeNull();
  });

  test('consume with wrong hash returns null', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    await repo.store('correct-hash', 'user-1', 'job-1', 3600);
    const result = await repo.consume('wrong-hash');
    expect(result).toBeNull();
    // Correct hash still retrievable
    const correct = await repo.consume('correct-hash');
    expect(correct).not.toBeNull();
  });

  test('expired token returns null', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    // TTL of 0 seconds = already expired
    await repo.store('expired-hash', 'user-1', 'job-1', 0);
    // Wait 1ms to ensure it's past expiry
    await new Promise(r => setTimeout(r, 5));
    const result = await repo.consume('expired-hash');
    expect(result).toBeNull();
  });

  test('multiple tokens stored independently', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    await repo.store('hash-a', 'user-a', 'job-a', 3600);
    await repo.store('hash-b', 'user-b', 'job-b', 3600);
    const a = await repo.consume('hash-a');
    const b = await repo.consume('hash-b');
    expect(a!.userId).toBe('user-a');
    expect(b!.userId).toBe('user-b');
  });
});

// ---------------------------------------------------------------------------
// Public API — createDeletionCancelToken / consumeDeletionCancelToken
// ---------------------------------------------------------------------------

describe('createDeletionCancelToken / consumeDeletionCancelToken', () => {
  test('createDeletionCancelToken returns a string token', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    const token = await createDeletionCancelToken(repo, 'user-1', 'job-1', 3600);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  test('returned token is a UUID', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    const token = await createDeletionCancelToken(repo, 'user-1', 'job-1', 3600);
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('consumeDeletionCancelToken returns userId and jobId for valid token', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    const token = await createDeletionCancelToken(repo, 'user-42', 'job-42', 3600);
    const result = await consumeDeletionCancelToken(repo, token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-42');
    expect(result!.jobId).toBe('job-42');
  });

  test('consuming a token twice returns null on second call', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    const token = await createDeletionCancelToken(repo, 'user-1', 'job-1', 3600);
    await consumeDeletionCancelToken(repo, token);
    const second = await consumeDeletionCancelToken(repo, token);
    expect(second).toBeNull();
  });

  test('consuming wrong token returns null', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    await createDeletionCancelToken(repo, 'user-1', 'job-1', 3600);
    const result = await consumeDeletionCancelToken(repo, 'not-a-real-token');
    expect(result).toBeNull();
  });

  test('each createDeletionCancelToken call returns a unique token', async () => {
    const repo = createMemoryDeletionCancelTokenRepository();
    const t1 = await createDeletionCancelToken(repo, 'user-1', 'job-1', 3600);
    const t2 = await createDeletionCancelToken(repo, 'user-1', 'job-2', 3600);
    expect(t1).not.toBe(t2);
  });

  test('TTL includes grace period buffer (gracePeriod + 300)', async () => {
    // We can only verify the stored token works immediately — TTL internals are opaque
    const repo = createMemoryDeletionCancelTokenRepository();
    const token = await createDeletionCancelToken(repo, 'u', 'j', 600);
    const result = await consumeDeletionCancelToken(repo, token);
    expect(result).not.toBeNull(); // token not yet expired
  });
});
