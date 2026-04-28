import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { bestEffort } from '../src/bestEffort';
import type { AppEnv } from '../src/context';
import { decodeCursor, encodeCursor } from '../src/cursor';
import { deepFreeze } from '../src/deepFreeze';
import { createEntityRegistry } from '../src/entityRegistry';
import { errorResponse } from '../src/errorResponse';
import { HttpError, UnsupportedAdapterFeatureError, ValidationError } from '../src/errors';
import {
  DEFAULT_MAX_ENTRIES,
  createEvictExpired,
  evictOldest,
  evictOldestArray,
} from '../src/memoryEviction';
import { routeKey, shouldMountRoute } from '../src/routeOverrides';
import { isValidRoomName } from '../src/wsHelpers';

let warnSpy: ReturnType<typeof spyOn> | null = null;
let nowSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = null;
  nowSpy?.mockRestore();
  nowSpy = null;
});

describe('slingshot-core utilities', () => {
  test('bestEffort ignores success and logs rejected promises with the optional label', async () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    bestEffort(Promise.resolve('ok'));
    bestEffort(Promise.reject(new Error('boom')), '[jobs]');
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toBe('[jobs] best-effort operation failed:');
    expect((warnSpy.mock.calls[0] ?? [])[1]).toBeInstanceOf(Error);
  });

  test('deepFreeze recursively freezes nested objects and arrays', () => {
    const value = {
      nested: { enabled: true },
      list: [{ id: 'one' }],
    };

    const frozen = deepFreeze(value);

    expect(frozen).toBe(value);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(Object.isFrozen(frozen.list)).toBe(true);
    expect(Object.isFrozen(frozen.list[0])).toBe(true);
    expect(deepFreeze('literal')).toBe('literal');
  });

  test('cursor helpers round-trip valid payloads and reject malformed or invalid ones', () => {
    const cursor = encodeCursor({ id: 'msg-1', createdAt: '2026-04-15T00:00:00Z' });

    expect(
      decodeCursor<{ id: string; createdAt: string }>(
        cursor,
        (parsed): parsed is { id: string; createdAt: string } =>
          typeof (parsed as { id?: unknown }).id === 'string' &&
          typeof (parsed as { createdAt?: unknown }).createdAt === 'string',
      ),
    ).toEqual({ id: 'msg-1', createdAt: '2026-04-15T00:00:00Z' });

    expect(
      decodeCursor<{ id: string }>(cursor, (parsed): parsed is { id: string } => {
        return typeof (parsed as { id?: unknown }).id === 'number';
      }),
    ).toBeNull();
    expect(decodeCursor('not-base64')).toBeNull();
  });

  test('memory eviction helpers trim maps, arrays, and expired entries predictably', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    evictOldest(map, 2);
    expect(Array.from(map.keys())).toEqual(['b', 'c']);

    const history = ['h1', 'h2', 'h3', 'h4'];
    evictOldestArray(history, 2);
    expect(history).toEqual(['h3', 'h4']);

    let now = 10_000;
    nowSpy = spyOn(Date, 'now').mockImplementation(() => now);
    const evictExpired = createEvictExpired(100);
    const ttlMap = new Map<string, { expiresAt?: number }>([
      ['live', { expiresAt: 10_500 }],
      ['expired', { expiresAt: 9_000 }],
    ]);

    evictExpired(ttlMap);
    expect(ttlMap.has('expired')).toBe(false);
    expect(ttlMap.has('live')).toBe(true);

    ttlMap.set('expired-later', { expiresAt: 9_500 });
    evictExpired(ttlMap);
    expect(ttlMap.has('expired-later')).toBe(true);

    now += 101;
    evictExpired(ttlMap);
    expect(ttlMap.has('expired-later')).toBe(false);
    expect(DEFAULT_MAX_ENTRIES).toBe(10_000);
  });

  test('error types preserve their structured metadata', () => {
    const httpError = new HttpError(404, 'Not found', 'NOT_FOUND');
    expect(httpError.status).toBe(404);
    expect(httpError.message).toBe('Not found');
    expect(httpError.code).toBe('NOT_FOUND');

    const parsed = z.object({ id: z.string() }).safeParse({ id: 42 });
    if (parsed.success) {
      throw new Error('expected parse failure');
    }
    const validationError = new ValidationError(parsed.error.issues);
    expect(validationError.status).toBe(400);
    expect(validationError.message).toBe('Validation failed');
    expect(validationError.issues).toEqual(parsed.error.issues);

    const unsupported = new UnsupportedAdapterFeatureError('listSessions', 'MemoryAuthAdapter');
    expect(unsupported.name).toBe('UnsupportedAdapterFeatureError');
    expect(unsupported.message).toBe(
      'listSessions is not supported by the MemoryAuthAdapter adapter',
    );
  });

  test('errorResponse returns a stable JSON shape that includes requestId', async () => {
    const app = new Hono<AppEnv>();
    app.get('/boom', c => {
      c.set('requestId' as never, 'req-123' as never);
      return errorResponse(c, 'Nope', 418);
    });

    const response = await app.request('/boom');

    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({
      error: 'Nope',
      requestId: 'req-123',
    });
  });

  test('routeKey and shouldMountRoute keep disable checks consistent', () => {
    const disabled = [routeKey('get', '/items'), routeKey('DELETE', '/items/:id')];

    expect(routeKey('post', '/items')).toBe('POST /items');
    expect(shouldMountRoute('GET', '/items', disabled)).toBe(false);
    expect(shouldMountRoute('delete', '/items/:id', disabled)).toBe(false);
    expect(shouldMountRoute('POST', '/items', disabled)).toBe(true);
    expect(shouldMountRoute('GET', '/items')).toBe(true);
  });

  test('createEntityRegistry freezes configs, returns copies, and rejects duplicates', () => {
    const registry = createEntityRegistry();
    const post = {
      name: 'Post',
      namespace: 'community',
      _storageName: 'posts',
    };
    const comment = {
      name: 'Comment',
      namespace: 'community',
      _storageName: 'comments',
    };

    registry.register(post as never);
    registry.register(comment as never);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all[0]).toBe(post as never);
    expect(Object.isFrozen(post)).toBe(true);

    (all as unknown as unknown[]).pop();
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.filter(config => config.name === 'Comment')).toEqual([comment as never]);
    const duplicateData = { ...post };
    const duplicate: never = duplicateData as never;
    expect(() => registry.register(duplicate)).toThrow(
      "Entity 'Post' (namespace: community) is already registered",
    );
  });

  test('isValidRoomName accepts supported room syntax and rejects invalid names', () => {
    expect(isValidRoomName('containers:abc123:live')).toBe(true);
    expect(isValidRoomName('room.with/slash-and-dash')).toBe(true);
    expect(isValidRoomName('bad room!')).toBe(false);
    expect(isValidRoomName('')).toBe(false);
    expect(isValidRoomName('x'.repeat(129))).toBe(false);
  });
});
