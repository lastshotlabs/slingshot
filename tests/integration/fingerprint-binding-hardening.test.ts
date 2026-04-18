/**
 * Tests for production session fingerprint binding hardening.
 *
 * Production boot must fail unless signing.sessionBinding is configured
 * explicitly. Explicit opt-out via `false` remains allowed so the decision is
 * conscious rather than accidental.
 */
import { spyOn } from 'bun:test';
import { afterEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

async function setupAuthPlugin(sessionBinding?: boolean) {
  await createTestApp(
    {
      security: {
        trustProxy: false,
        signing: {
          secret: 'test-secret-key-must-be-at-least-32-chars!!',
          ...(sessionBinding === undefined ? {} : { sessionBinding }),
        },
      },
    },
    {
      security: {
        bearerAuth: false,
      },
      auth: {
        jwt: {
          issuer: 'https://auth.example.com',
          audience: 'slingshot-api',
        },
      },
    },
  );
}

describe('fingerprint binding production hardening', () => {
  test('production boot fails when sessionBinding is not configured', async () => {
    process.env.NODE_ENV = 'production';
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(setupAuthPlugin()).rejects.toThrow(
        /signing\.sessionBinding must be explicitly configured in production/i,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('production boot succeeds when sessionBinding is explicitly false', async () => {
    process.env.NODE_ENV = 'production';
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(setupAuthPlugin(false)).resolves.toBeUndefined();
      const fingerprintWarnings = warnSpy.mock.calls.filter(args =>
        String(args[0]).includes('Session fingerprint binding'),
      );
      expect(fingerprintWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('production boot succeeds when sessionBinding is configured to true', async () => {
    process.env.NODE_ENV = 'production';
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(setupAuthPlugin(true)).resolves.toBeUndefined();
      const fingerprintWarnings = warnSpy.mock.calls.filter(args =>
        String(args[0]).includes('Session fingerprint binding'),
      );
      expect(fingerprintWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('development boot does not require sessionBinding', async () => {
    process.env.NODE_ENV = 'development';
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(setupAuthPlugin()).resolves.toBeUndefined();
      const fingerprintWarnings = warnSpy.mock.calls.filter(args =>
        String(args[0]).includes('Session fingerprint binding'),
      );
      expect(fingerprintWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
