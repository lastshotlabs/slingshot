/**
 * Integration tests for account deletion cancellation.
 *
 * Covers:
 * - `createDeletionCancelToken` / `consumeDeletionCancelToken` service functions
 * - POST /auth/cancel-deletion route (token consumption, error handling)
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import {
  consumeDeletionCancelToken,
  createDeletionCancelToken,
  createMemoryDeletionCancelTokenRepository,
} from '../../src/lib/deletionCancelToken';
import type { DeletionCancelTokenRepository } from '../../src/lib/deletionCancelToken';
import { createAccountDeletionRouter } from '../../src/routes/accountDeletion';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Token service functions (unit-level)
// ---------------------------------------------------------------------------

describe('createDeletionCancelToken / consumeDeletionCancelToken', () => {
  let repo: DeletionCancelTokenRepository;

  beforeEach(() => {
    repo = createMemoryDeletionCancelTokenRepository();
  });

  test('creates a token and consumes it returning userId and jobId', async () => {
    const token = await createDeletionCancelToken(repo, 'user-1', 'job-42', 3600);
    const result = await consumeDeletionCancelToken(repo, token);

    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.jobId).toBe('job-42');
  });

  test('token is single-use — second consume returns null', async () => {
    const token = await createDeletionCancelToken(repo, 'user-1', 'job-42', 3600);

    await consumeDeletionCancelToken(repo, token);
    const second = await consumeDeletionCancelToken(repo, token);
    expect(second).toBeNull();
  });

  test('consuming a bogus token returns null', async () => {
    await createDeletionCancelToken(repo, 'user-1', 'job-42', 3600);
    const result = await consumeDeletionCancelToken(repo, 'not-a-real-token');
    expect(result).toBeNull();
  });

  test('each call produces a unique token', async () => {
    const t1 = await createDeletionCancelToken(repo, 'user-1', 'job-1', 3600);
    const t2 = await createDeletionCancelToken(repo, 'user-1', 'job-2', 3600);
    expect(t1).not.toBe(t2);
  });

  test('different tokens for same user are independent', async () => {
    const t1 = await createDeletionCancelToken(repo, 'user-1', 'job-1', 3600);
    const t2 = await createDeletionCancelToken(repo, 'user-1', 'job-2', 3600);

    const r1 = await consumeDeletionCancelToken(repo, t1);
    expect(r1).not.toBeNull();
    expect(r1!.jobId).toBe('job-1');

    const r2 = await consumeDeletionCancelToken(repo, t2);
    expect(r2).not.toBeNull();
    expect(r2!.jobId).toBe('job-2');
  });

  test('token expires after TTL elapses', async () => {
    // gracePeriodSeconds = 0 means ttl = 0 + 300 = 300 — too long to wait.
    // Use the repo directly with a TTL of 0 to test expiry.
    const { sha256 } = await import('@lastshotlabs/slingshot-core');
    const rawToken = 'test-token-for-expiry';
    const hash = sha256(rawToken);
    await repo.store(hash, 'user-1', 'job-1', 0);

    // TTL of 0 means expiresAt = Date.now() + 0 => already expired
    await new Promise(resolve => setTimeout(resolve, 5));

    const result = await repo.consume(hash);
    expect(result).toBeNull();
  });

  test('multiple repos are independent (no shared state)', async () => {
    const repo2 = createMemoryDeletionCancelTokenRepository();
    const token = await createDeletionCancelToken(repo, 'user-1', 'job-1', 3600);

    // Token exists in repo but not in repo2
    const r2 = await consumeDeletionCancelToken(repo2, token);
    expect(r2).toBeNull();

    // Original repo still has it
    const r1 = await consumeDeletionCancelToken(repo, token);
    expect(r1).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /auth/cancel-deletion route
// ---------------------------------------------------------------------------

describe('POST /auth/cancel-deletion', () => {
  let app: ReturnType<typeof wrapWithRuntime>;
  let runtime: MutableTestRuntime;

  // Minimal mock queue factory: createQueue returns a stub that does nothing.
  const mockQueueFactory = {
    createQueue: () => ({
      getJob: async () => null,
      close: async () => {},
    }),
  };

  beforeEach(() => {
    runtime = makeTestRuntime({ concealRegistration: null });
    runtime.eventBus = makeEventBus();
    // Inject mock queue factory so the route does not throw on missing BullMQ
    runtime.queueFactory = mockQueueFactory as unknown as MutableTestRuntime['queueFactory'];

    const honoApp = wrapWithRuntime(runtime);
    honoApp.onError((err, c) =>
      c.json(
        { error: err.message },
        (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
      ),
    );
    honoApp.route(
      '/',
      createAccountDeletionRouter(
        { accountDeletion: { queued: true, gracePeriod: 86400 } },
        runtime,
      ),
    );
    app = honoApp;
  });

  const jsonPost = (path: string, body: Record<string, unknown>) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('valid token returns 200', async () => {
    const token = await createDeletionCancelToken(
      runtime.repos.deletionCancelToken,
      'user-1',
      'job-42',
      86400,
    );

    const res = await jsonPost('/auth/cancel-deletion', { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('invalid token returns 400', async () => {
    const res = await jsonPost('/auth/cancel-deletion', { token: 'bogus-token' });
    expect(res.status).toBe(400);
  });

  test('token consumed once — second use returns 400', async () => {
    const token = await createDeletionCancelToken(
      runtime.repos.deletionCancelToken,
      'user-1',
      'job-42',
      86400,
    );

    const first = await jsonPost('/auth/cancel-deletion', { token });
    expect(first.status).toBe(200);

    const second = await jsonPost('/auth/cancel-deletion', { token });
    expect(second.status).toBe(400);
  });

  test('missing token field returns 400', async () => {
    const res = await jsonPost('/auth/cancel-deletion', {});
    expect(res.status).toBe(400);
  });
});
