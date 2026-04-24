/**
 * Unit tests for resolveActorId.
 *
 * Covers: null resolver short-circuits, resolver.resolveActorId is called with the request,
 * and the result is returned verbatim (string or null).
 */
import { describe, expect, mock, test } from 'bun:test';
import { resolveActorId } from '../../src/framework/lib/resolveActorId';

describe('resolveActorId', () => {
  test('returns null immediately when resolver is null', async () => {
    const req = new Request('http://example.com');
    const result = await resolveActorId(req, null);
    expect(result).toBeNull();
  });

  test('calls resolver.resolveActorId with the request', async () => {
    const req = new Request('http://example.com');
    const resolveActorIdMock = mock(async () => 'user-123');
    const resolver = { resolveActorId: resolveActorIdMock };
    await resolveActorId(req, resolver);
    expect(resolveActorIdMock).toHaveBeenCalledWith(req);
  });

  test('returns the userId from the resolver', async () => {
    const req = new Request('http://example.com');
    const resolver = { resolveActorId: mock(async () => 'user-abc') };
    const result = await resolveActorId(req, resolver);
    expect(result).toBe('user-abc');
  });

  test('returns null when resolver returns null', async () => {
    const req = new Request('http://example.com');
    const resolver = { resolveActorId: mock(async () => null) };
    const result = await resolveActorId(req, resolver);
    expect(result).toBeNull();
  });

  test('resolver is called exactly once per invocation', async () => {
    const req = new Request('http://example.com');
    const resolveActorIdMock = mock(async () => 'u');
    const resolver = { resolveActorId: resolveActorIdMock };
    await resolveActorId(req, resolver);
    await resolveActorId(req, resolver);
    expect(resolveActorIdMock).toHaveBeenCalledTimes(2);
  });
});
