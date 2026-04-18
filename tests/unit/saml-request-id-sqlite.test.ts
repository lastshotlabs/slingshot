import {
  type SamlRequestIdRepository,
  consumeSamlRequestId,
  createMemorySamlRequestIdRepository,
  createSqliteSamlRequestIdRepository,
  storeSamlRequestId,
} from '@auth/lib/samlRequestId';
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';

function makeDb(): Database {
  return new Database(':memory:');
}

describe('SAML request ID — sqlite store', () => {
  let repo: SamlRequestIdRepository;

  beforeEach(() => {
    const db = makeDb();
    repo = createSqliteSamlRequestIdRepository(db);
  });

  test('store and consume a request ID succeeds', async () => {
    const requestId = 'test-request-id-12345';
    await storeSamlRequestId(repo, requestId);
    const consumed = await consumeSamlRequestId(repo, requestId);
    expect(consumed).toBe(true);
  });

  test('consuming the same ID twice returns false (single-use)', async () => {
    const requestId = 'single-use-request-id';
    await storeSamlRequestId(repo, requestId);
    const first = await consumeSamlRequestId(repo, requestId);
    const second = await consumeSamlRequestId(repo, requestId);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test('consuming a non-existent ID returns false', async () => {
    const consumed = await consumeSamlRequestId(repo, 'never-stored-id');
    expect(consumed).toBe(false);
  });

  test('when db is null (not injected), store silently no-ops and consume returns false', async () => {
    const nullRepo = createSqliteSamlRequestIdRepository(null as any);

    // Should not throw
    await storeSamlRequestId(nullRepo, 'some-id');
    const consumed = await consumeSamlRequestId(nullRepo, 'some-id');
    expect(consumed).toBe(false);
  });
});

describe('SAML request ID — memory store (regression)', () => {
  test('memory store still works after sqlite changes', async () => {
    const repo = createMemorySamlRequestIdRepository();

    const requestId = 'memory-request-id';
    await storeSamlRequestId(repo, requestId);
    const consumed = await consumeSamlRequestId(repo, requestId);
    expect(consumed).toBe(true);
  });
});
