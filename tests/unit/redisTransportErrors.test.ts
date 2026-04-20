/**
 * Tests for requireIoredis error paths in redisTransport.ts (lines 36-38).
 *
 * Separate file because mock.module is permanent per-file.
 * This mock returns an invalid shape to exercise the error path.
 */
import { describe, expect, mock, test } from 'bun:test';
import { createRedisTransport } from '../../src/framework/ws/redisTransport';

// Mock ioredis with an invalid shape (not a constructor, no default)
mock.module('ioredis', () => {
  return { notAConstructor: 'invalid' };
});

describe('requireIoredis — error paths', () => {
  test('throws when ioredis module has invalid shape (not a constructor)', async () => {
    const transport = createRedisTransport({ connection: 'redis://localhost:6379' });

    await expect(transport.connect(() => {})).rejects.toThrow(
      'ioredis is required for RedisTransport',
    );
  });
});
