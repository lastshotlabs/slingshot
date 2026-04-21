import { describe, expect, spyOn, test } from 'bun:test';
import { createApp } from '../../src/app';
import { authPlugin } from '../setup';

describe('logging config', () => {
  test('logging config suppresses auth diagnostics and audit warnings even when env logging is verbose', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const { app, ctx } = await createApp({
      routesDir: `${import.meta.dir}/../fixtures/routes`,
      meta: { name: 'Logging Config Test App' },
      db: {
        mongo: false,
        redis: false,
        sessions: 'memory',
        cache: 'memory',
        auth: 'memory',
      },
      security: {
        rateLimit: { windowMs: 60_000, max: 1000 },
        signing: {
          secret: 'test-secret-key-must-be-at-least-32-chars!!',
          sessionBinding: false,
        },
      },
      logging: {
        onLog: () => {},
        verbose: false,
        auditWarnings: false,
      },
      plugins: [authPlugin()],
    });

    try {
      const response = await app.request('/cached');
      expect(response.status).toBe(200);

      const identifyLogs = logSpy.mock.calls.filter(args =>
        args.some(value => typeof value === 'string' && value.includes('[identify]')),
      );
      const auditWarnings = warnSpy.mock.calls.filter(args =>
        args.some(
          value => typeof value === 'string' && value.includes('Memory adapter for audit log'),
        ),
      );

      expect(identifyLogs).toHaveLength(0);
      expect(auditWarnings).toHaveLength(0);
    } finally {
      await ctx.destroy().catch(() => {});
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
