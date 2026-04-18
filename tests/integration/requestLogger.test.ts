import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { requestLogger } from '../../src/framework/middleware/requestLogger';
import type { RequestLogEntry } from '../../src/framework/middleware/requestLogger';

// Use a minimal Hono app with onError that re-throws, so errors propagate
// through requestLogger's catch block.
function createMinimalApp(logEntries: RequestLogEntry[]) {
  const app = new Hono();

  app.use(
    requestLogger({
      onLog: entry => {
        logEntries.push(entry);
      },
      excludePaths: [], // don't exclude anything
    }),
  );

  // Re-throw errors so they propagate to requestLogger's catch
  app.onError(err => {
    throw err;
  });

  app.get('/ok', c => c.json({ ok: true }));

  app.get('/throw-error', () => {
    throw new Error('Test handler error');
  });

  app.get('/throw-string', () => {
    throw 'string error value'; // eslint-disable-line no-throw-literal
  });

  return app;
}

describe('requestLogger middleware', () => {
  test('logs error entry with Error object when handler throws', async () => {
    const logEntries: RequestLogEntry[] = [];
    const app = createMinimalApp(logEntries);

    try {
      await app.request('/throw-error');
    } catch {
      // error re-thrown by requestLogger after logging
    }

    const errorEntry = logEntries.find(e => e.path === '/throw-error');
    expect(errorEntry).toBeDefined();
    expect(errorEntry!.level).toBe('error');
    expect(errorEntry!.statusCode).toBe(500);
    expect(errorEntry!.msg).toContain('ERROR');
    expect(errorEntry!.err).toBeDefined();
    expect(errorEntry!.err!.message).toBe('Test handler error');
    expect(errorEntry!.err!.stack).toBeDefined();
  });

  test('logs error entry with string error serialization when handler throws non-Error', async () => {
    const logEntries: RequestLogEntry[] = [];
    const app = createMinimalApp(logEntries);

    try {
      await app.request('/throw-string');
    } catch {
      // error re-thrown by requestLogger after logging
    }

    const errorEntry = logEntries.find(e => e.path === '/throw-string');
    expect(errorEntry).toBeDefined();
    expect(errorEntry!.level).toBe('error');
    expect(errorEntry!.err).toBeDefined();
    expect(errorEntry!.err!.message).toBe('string error value');
    expect(errorEntry!.err!.stack).toBeUndefined();
  });
});
