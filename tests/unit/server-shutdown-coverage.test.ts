import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createServer, getServerContext } from '../../src/server';

// ---------------------------------------------------------------------------
// Shutdown registry helpers
// ---------------------------------------------------------------------------

const SHUTDOWN_REGISTRY_SYMBOL = Symbol.for('slingshot.shutdownRegistry');

type ShutdownRegistry = {
  callbacks: Map<string, (signal: string) => Promise<number>>;
  listeners: { sigterm: () => void; sigint: () => void } | null;
};

function getRegistry(): ShutdownRegistry | undefined {
  const proc = process as unknown as Record<symbol, ShutdownRegistry | undefined>;
  return proc[SHUTDOWN_REGISTRY_SYMBOL];
}

function getLastShutdownCallback(): (signal: string) => Promise<number> {
  const registry = getRegistry()!;
  const entries = [...registry.callbacks.entries()];
  return entries[entries.length - 1][1];
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms waiting for ${label}`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Base config — no external deps (mongo, redis disabled)
// ---------------------------------------------------------------------------

const baseConfig = {
  meta: { name: 'Shutdown Coverage Test' },
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

// ---------------------------------------------------------------------------
// Helpers — force fresh dispatch closure
// ---------------------------------------------------------------------------

/**
 * Reset the shutdown listener closure so each test gets a fresh `dispatching`
 * variable. Without this, the `dispatching = true` guard from a previous test
 * prevents subsequent dispatch calls from executing.
 */
function resetShutdownListeners() {
  const registry = getRegistry();
  if (!registry?.listeners) return;
  // Remove the old process listeners
  process.off('SIGTERM', registry.listeners.sigterm);
  process.off('SIGINT', registry.listeners.sigint);
  // Setting to null forces ensureProcessShutdownListeners to re-create
  // a new closure with dispatching = false
  registry.listeners = null;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let server: Awaited<ReturnType<typeof createServer>> | null = null;
let origExit: typeof process.exit | null = null;

afterEach(async () => {
  // Restore process.exit if we mocked it
  if (origExit) {
    process.exit = origExit;
    origExit = null;
  }

  // Reset listeners so the next test gets a fresh dispatching closure
  resetShutdownListeners();

  if (server) {
    try {
      const ctx = getServerContext(server);
      server.stop(true);
      await ctx?.destroy();
    } catch {
      /* best-effort */
    }
    server = null;
  }
});

// =========================================================================
// 1. Process shutdown dispatch (lines 86-103)
//    The `dispatch` function is invoked by the registered SIGTERM/SIGINT
//    listeners. It calls process.exit() after all callbacks resolve.
//    We mock process.exit to prevent the test runner from dying.
// =========================================================================

describe('process shutdown dispatch (lines 86-103)', () => {
  test('dispatch via sigterm listener calls process.exit(0) on success', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });

    const registry = getRegistry()!;
    expect(registry.listeners).not.toBeNull();

    // Mock process.exit to capture the exit code
    const exitCalls: number[] = [];
    origExit = process.exit;
    process.exit = mock((code?: number) => {
      exitCalls.push(code ?? 0);
    }) as any;

    // Invoke the sigterm listener directly
    registry.listeners!.sigterm();

    // The dispatch function is async — wait for it to complete
    await withTimeout(
      new Promise<void>(resolve => {
        const check = () => {
          if (exitCalls.length > 0) return resolve();
          setTimeout(check, 10);
        };
        check();
      }),
      5_000,
      'process.exit call',
    );

    expect(exitCalls).toContain(0);
    server = null; // server was already stopped by gracefulShutdown
  });

  test('dispatch via sigint listener calls process.exit(1) on callback failure', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });

    const registry = getRegistry()!;

    // Replace the server's shutdown callback with one that rejects
    const entries = [...registry.callbacks.entries()];
    const [key] = entries[entries.length - 1];
    registry.callbacks.set(key, async () => {
      throw new Error('forced failure');
    });

    const exitCalls: number[] = [];
    origExit = process.exit;
    process.exit = mock((code?: number) => {
      exitCalls.push(code ?? 0);
    }) as any;

    // Invoke sigint listener
    registry.listeners!.sigint();

    await withTimeout(
      new Promise<void>(resolve => {
        const check = () => {
          if (exitCalls.length > 0) return resolve();
          setTimeout(check, 10);
        };
        check();
      }),
      5_000,
      'process.exit call',
    );

    expect(exitCalls).toContain(1);
    server = null;
  });

  test('dispatch ignores duplicate signals (dispatching guard)', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });

    const registry = getRegistry()!;

    const exitCalls: number[] = [];
    origExit = process.exit;
    process.exit = mock((code?: number) => {
      exitCalls.push(code ?? 0);
    }) as any;

    // Fire both signals rapidly — second should be ignored
    registry.listeners!.sigterm();
    registry.listeners!.sigint();

    await withTimeout(
      new Promise<void>(resolve => {
        const check = () => {
          if (exitCalls.length > 0) return resolve();
          setTimeout(check, 10);
        };
        check();
      }),
      5_000,
      'process.exit call',
    );

    // Only one exit call should occur
    expect(exitCalls.length).toBe(1);
    server = null;
  });

  test('dispatch calls process.exit(1) when callback returns non-zero', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });

    const registry = getRegistry()!;

    // Replace callback with one that returns exit code 1
    const entries = [...registry.callbacks.entries()];
    const [key] = entries[entries.length - 1];
    registry.callbacks.set(key, async () => 1);

    const exitCalls: number[] = [];
    origExit = process.exit;
    process.exit = mock((code?: number) => {
      exitCalls.push(code ?? 0);
    }) as any;

    registry.listeners!.sigterm();

    await withTimeout(
      new Promise<void>(resolve => {
        const check = () => {
          if (exitCalls.length > 0) return resolve();
          setTimeout(check, 10);
        };
        check();
      }),
      5_000,
      'process.exit call',
    );

    expect(exitCalls).toContain(1);
    server = null;
  });

  test('force-exit timeout fires process.exit(1) when callbacks hang (lines 90-93)', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });

    const registry = getRegistry()!;

    // Replace callback with one that never resolves
    const entries = [...registry.callbacks.entries()];
    const [key] = entries[entries.length - 1];
    registry.callbacks.set(key, () => new Promise(() => {})); // hangs forever

    const exitCalls: number[] = [];
    origExit = process.exit;
    process.exit = mock((code?: number) => {
      exitCalls.push(code ?? 0);
    }) as any;

    // Shim setTimeout: when delay >= 10000 (the force-exit timeout is 30000),
    // fire immediately instead of waiting. Preserves short-delay timers.
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms && ms >= 10_000) {
        // Fire force-exit callback immediately
        return origSetTimeout(fn, 0, ...args);
      }
      return origSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout;

    try {
      registry.listeners!.sigterm();

      await withTimeout(
        new Promise<void>(resolve => {
          const check = () => {
            if (exitCalls.length > 0) return resolve();
            origSetTimeout(check, 10);
          };
          check();
        }),
        5_000,
        'force-exit process.exit call',
      );

      // Force-exit path calls process.exit(1)
      expect(exitCalls).toContain(1);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    server = null;
  });
});

// =========================================================================
// 2. SQLite close in graceful shutdown (lines 634-639)
// =========================================================================

describe('SQLite close in graceful shutdown (lines 634-639)', () => {
  test('shutdown closes SQLite database', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      db: {
        ...baseConfig.db,
        sqlite: ':memory:',
      },
    });

    const ctx = getServerContext(server)!;
    expect(ctx.sqliteDb).not.toBeNull();

    // Verify db works before shutdown
    ctx.sqliteDb!.run('CREATE TABLE shutdown_proof (id INTEGER PRIMARY KEY)');

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    expect(exitCode).toBe(0);

    // After shutdown, the db handle should be closed — operations should throw
    expect(() => ctx.sqliteDb!.run('SELECT 1 FROM shutdown_proof')).toThrow();
    server = null;
  });

  test('shutdown handles SQLite close error (lines 637-639)', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      db: {
        ...baseConfig.db,
        sqlite: ':memory:',
      },
    });

    const ctx = getServerContext(server)!;
    expect(ctx.sqliteDb).not.toBeNull();

    // Replace close() with a function that throws
    const origClose = ctx.sqliteDb!.close.bind(ctx.sqliteDb);
    (ctx as any).sqliteDb.close = () => {
      throw new Error('SQLite close boom');
    };

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    expect(exitCode).toBe(1);

    // Restore and actually close
    try { origClose(); } catch { /* already closed or error */ }
    server = null;
  });
});

// =========================================================================
// 3. Outer catch in graceful shutdown (lines 642-643)
//    The outer try/catch wraps the entire shutdown body. To trigger it,
//    we need something to throw outside the inner try blocks. We can make
//    server.stop() throw to hit the outer catch.
// =========================================================================

describe('outer catch in graceful shutdown (lines 642-643)', () => {
  test('unhandled error in shutdown body sets exit code 1', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });

    // Sabotage server.stop to throw an unexpected error that will be caught
    // by the outer try/catch in gracefulShutdown
    const origStop = server.stop.bind(server);
    (server as any).stop = () => {
      throw new Error('unexpected stop failure');
    };

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    expect(exitCode).toBe(1);

    // Actually stop the server for cleanup
    try { origStop(true); } catch { /* best-effort */ }
    server = null;
  });
});

// =========================================================================
// 4. Bun.serve error handlers (lines 485-486, 530-531) — documented as
//    uncoverable without Bun internals
// =========================================================================

describe('Bun.serve error handlers (lines 485-486, 530-531)', () => {
  test.skip('error(err) only fires when app.fetch throws outside Hono — not triggerable in unit tests', () => {
    // Both the WS-path (line 485) and HTTP-only-path (line 530) error handlers
    // are callbacks passed to Bun.serve({ error(err) { ... } }). Bun invokes
    // them only when the fetch function itself throws synchronously before
    // producing a Response. Hono wraps all route handlers in try/catch and
    // returns its own error response, so route-level errors never reach the
    // Bun error callback. To trigger it you'd need to cause Hono's internal
    // fetch to throw before it can catch — which requires patching Bun.serve
    // internals or the Hono prototype, neither of which is reliable.
  });
});

// =========================================================================
// 5. Drain handler (line 448) — documented as uncoverable
// =========================================================================

describe('WS drain handler (line 448)', () => {
  test.skip('drain callback requires WebSocket backpressure — impractical in unit tests', () => {
    // The `drain(socket)` callback (line 448) fires when a WebSocket's send
    // buffer drops below the backpressureLimit after being full. Triggering
    // this requires filling the WebSocket buffer past backpressureLimit,
    // which needs a client that reads slowly enough for the server-side
    // buffer to fill up. This is impractical in a unit test environment
    // where both ends run in the same process with zero network latency.
  });
});

// =========================================================================
// 6. Redis/Mongo disconnect in shutdown (lines 616-631)
//    Documented as untestable without integration infrastructure
// =========================================================================

describe('Redis/Mongo disconnect in shutdown (lines 616-631)', () => {
  // The shutdown closure captures `config` by reference and reads `config.db`
  // at shutdown time. By mutating config.db after server creation and injecting
  // mock clients on ctx, we can exercise the disconnect branches without
  // needing live Redis/Mongo infrastructure.

  test('shutdown calls disconnectRedis when config.db.redis is truthy and ctx.redis is set', async () => {
    const db: Record<string, unknown> = {
      ...baseConfig.db,
      redis: false,
    };
    const config = { ...baseConfig, db, hostname: '127.0.0.1', port: 0 };
    server = await createServer(config);

    const ctx = getServerContext(server)!;

    // Mutate the captured config to enable Redis for shutdown
    db.redis = true;
    // Inject a mock Redis client with quit()
    const quitMock = mock(async () => {});
    (ctx as any).redis = { quit: quitMock };

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');

    expect(exitCode).toBe(0);
    expect(quitMock).toHaveBeenCalledTimes(1);
    server = null;
  });

  test('shutdown sets exit code 1 when Redis disconnect throws', async () => {
    const db: Record<string, unknown> = {
      ...baseConfig.db,
      redis: false,
    };
    const config = { ...baseConfig, db, hostname: '127.0.0.1', port: 0 };
    server = await createServer(config);

    const ctx = getServerContext(server)!;

    db.redis = true;
    (ctx as any).redis = {
      quit: async () => { throw new Error('Redis quit failed'); },
    };

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');

    expect(exitCode).toBe(1);
    server = null;
  });

  test('shutdown calls disconnectMongo when mongoMode is not false and ctx.mongo is set', async () => {
    const db: Record<string, unknown> = {
      ...baseConfig.db,
      mongo: false,
    };
    const config = { ...baseConfig, db, hostname: '127.0.0.1', port: 0 };
    server = await createServer(config);

    const ctx = getServerContext(server)!;

    // Mutate config to enable Mongo for shutdown
    db.mongo = 'single';
    // Inject mock Mongo connections with close()
    const authClose = mock(async () => {});
    const appClose = mock(async () => {});
    (ctx as any).mongo = {
      auth: { readyState: 1, close: authClose },
      app: { readyState: 1, close: appClose },
    };

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');

    expect(exitCode).toBe(0);
    expect(authClose).toHaveBeenCalledTimes(1);
    expect(appClose).toHaveBeenCalledTimes(1);
    server = null;
  });

  test('shutdown sets exit code 1 when Mongo disconnect throws', async () => {
    const db: Record<string, unknown> = {
      ...baseConfig.db,
      mongo: false,
    };
    const config = { ...baseConfig, db, hostname: '127.0.0.1', port: 0 };
    server = await createServer(config);

    const ctx = getServerContext(server)!;

    db.mongo = 'single';
    (ctx as any).mongo = {
      auth: { readyState: 1, close: async () => { throw new Error('auth close failed'); } },
      app: null,
    };

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');

    expect(exitCode).toBe(1);
    server = null;
  });
});
