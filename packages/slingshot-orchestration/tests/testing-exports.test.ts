import { describe, expect, test } from 'bun:test';
import {
  TEST_DEFAULT_PAGE_SIZE,
  TEST_ROUTE_TIMEOUT_MS,
  createTestRequestContext,
} from '../src/testing';

describe('orchestration plugin testing entrypoint', () => {
  test('exports route defaults and request context factory', () => {
    expect(TEST_ROUTE_TIMEOUT_MS).toBe(5_000);
    expect(TEST_DEFAULT_PAGE_SIZE).toBe(20);
    expect(createTestRequestContext()).toEqual({
      tenantId: 'test-tenant',
      actorId: 'test-actor',
      tags: {},
      metadata: {},
    });
    expect(
      createTestRequestContext({ tenantId: 'tenant-1', metadata: { traceId: 'trace-1' } }),
    ).toEqual({
      tenantId: 'tenant-1',
      actorId: 'test-actor',
      tags: {},
      metadata: { traceId: 'trace-1' },
    });
  });
});
