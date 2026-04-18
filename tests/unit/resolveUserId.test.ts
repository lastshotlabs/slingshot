/**
 * Unit tests for resolveUserId.
 *
 * Covers: null resolver short-circuits, resolver.resolveUserId is called with the request,
 * and the result is returned verbatim (string or null).
 */
import { describe, expect, mock, test } from 'bun:test';
import { resolveUserId } from '../../src/framework/lib/resolveUserId';

describe('resolveUserId', () => {
  test('returns null immediately when resolver is null', async () => {
    const req = new Request('http://example.com');
    const result = await resolveUserId(req, null);
    expect(result).toBeNull();
  });

  test('calls resolver.resolveUserId with the request', async () => {
    const req = new Request('http://example.com');
    const resolveUserIdMock = mock(async (_req: Request) => 'user-123');
    const resolver = { resolveUserId: resolveUserIdMock };
    await resolveUserId(req, resolver);
    expect(resolveUserIdMock).toHaveBeenCalledWith(req);
  });

  test('returns the userId from the resolver', async () => {
    const req = new Request('http://example.com');
    const resolver = { resolveUserId: mock(async () => 'user-abc') };
    const result = await resolveUserId(req, resolver);
    expect(result).toBe('user-abc');
  });

  test('returns null when resolver returns null', async () => {
    const req = new Request('http://example.com');
    const resolver = { resolveUserId: mock(async () => null) };
    const result = await resolveUserId(req, resolver);
    expect(result).toBeNull();
  });

  test('resolver is called exactly once per invocation', async () => {
    const req = new Request('http://example.com');
    const resolveUserIdMock = mock(async () => 'u');
    const resolver = { resolveUserId: resolveUserIdMock };
    await resolveUserId(req, resolver);
    await resolveUserId(req, resolver);
    expect(resolveUserIdMock).toHaveBeenCalledTimes(2);
  });
});
