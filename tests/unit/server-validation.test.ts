import { describe, expect, test } from 'bun:test';
import { createServer } from '../../src/server';

// These tests validate the startup checks that run before createApp is called
// (unix mutual exclusivity, port validation). They should throw immediately
// without needing any database connections.

const baseConfig = {
  meta: { name: 'Server Validation Test' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

describe('createServer startup validation', () => {
  test('unix and port are mutually exclusive', async () => {
    await expect(
      createServer({
        ...baseConfig,
        unix: '/tmp/test.sock',
        port: 3000,
      }),
    ).rejects.toThrow('[slingshot] unix and port are mutually exclusive');
  });

  test('unix and hostname are mutually exclusive', async () => {
    await expect(
      createServer({
        ...baseConfig,
        unix: '/tmp/test.sock',
        hostname: '0.0.0.0',
      }),
    ).rejects.toThrow('[slingshot] unix and hostname are mutually exclusive');
  });

  test('unix sockets do not support TLS', async () => {
    await expect(
      createServer({
        ...baseConfig,
        unix: '/tmp/test.sock',
        tls: { key: 'key', cert: 'cert' },
      }),
    ).rejects.toThrow('[slingshot] unix sockets do not support TLS');
  });
});
