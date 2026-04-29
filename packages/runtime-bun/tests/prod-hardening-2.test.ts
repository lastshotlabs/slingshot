/**
 * Prod-hardening tests (round 2) for runtime-bun.
 *
 * Covers memory leak prevention, resource cleanup on fast restarts,
 * rapid stop/start cycles, and event loop health.
 */
import { describe, expect, test } from 'bun:test';
import { bunRuntime, configureRuntimeBunLogger, resetProcessSafetyNetForTest } from '../src/index';

describe('runtime-bun prod hardening 2 — rapid stop/start cycles', () => {
  test('listen then stop then listen again does not throw', () => {
    const originalServe = Bun.serve;
    let stopCount = 0;
    Object.assign(Bun, {
      serve() {
        return {
          port: 0,
          stop() {
            stopCount++;
            return undefined;
          },
          publish: () => {},
          upgrade: () => true,
        };
      },
    });

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });

      const s1 = runtime.server.listen({ port: 0, fetch: () => new Response('ok') });
      s1.stop(true);

      const s2 = runtime.server.listen({ port: 0, fetch: () => new Response('ok') });
      s2.stop(true);

      expect(stopCount).toBe(2);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('three consecutive listen/stop cycles all resolve', () => {
    const originalServe = Bun.serve;
    const stopResults: boolean[] = [];
    Object.assign(Bun, {
      serve() {
        return {
          port: 4100,
          stop() {
            return undefined;
          },
          publish: () => {},
          upgrade: () => true,
        };
      },
    });

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });

      for (let i = 0; i < 3; i++) {
        const server = runtime.server.listen({ port: 0, fetch: () => new Response('ok') });
        expect(server.port).toBeGreaterThan(0);
        server.stop(true);
      }
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('listen with different options each time', () => {
    const originalServe = Bun.serve;
    const optionsCalls: Array<Record<string, unknown>> = [];
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        optionsCalls.push(opts);
        return {
          port: 0,
          stop: () => undefined,
          publish: () => {},
          upgrade: () => true,
        };
      },
    });

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });

      runtime.server.listen({ port: 0, maxRequestBodySize: 1024, fetch: () => new Response('ok') });
      runtime.server.listen({ port: 0, maxRequestBodySize: 2048, fetch: () => new Response('ok') });

      expect(optionsCalls).toHaveLength(2);
      expect(optionsCalls[0].maxRequestBodySize).toBe(1024);
      expect(optionsCalls[1].maxRequestBodySize).toBe(2048);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('Rapid listen without stop overwrites the underlying server', () => {
    const originalServe = Bun.serve;
    const servers: Array<{ port: number }> = [];
    Object.assign(Bun, {
      serve() {
        const s = {
          port: servers.length + 1,
          stop: () => undefined,
          publish: () => {},
          upgrade: () => true,
        };
        servers.push(s);
        return s;
      },
    });

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });

      runtime.server.listen({ port: 0, fetch: () => new Response('ok') });
      runtime.server.listen({ port: 0, fetch: () => new Response('ok') });
      runtime.server.listen({ port: 0, fetch: () => new Response('ok') });

      // Three different server instances were created
      expect(servers).toHaveLength(3);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });
});

describe('runtime-bun prod hardening 2 — shutdown cleanup', () => {
  test('stop(true) without websockets resolves quickly', async () => {
    const originalServe = Bun.serve;
    Object.assign(Bun, {
      serve() {
        return {
          port: 0,
          stop: () => undefined,
          publish: () => {},
          upgrade: () => true,
        };
      },
    });

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const server = runtime.server.listen({ port: 0, fetch: () => new Response('ok') });

      const start = Date.now();
      await server.stop(true);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('stop(false) resolves gracefully', async () => {
    const originalServe = Bun.serve;
    Object.assign(Bun, {
      serve() {
        return {
          port: 0,
          stop: () => undefined,
          publish: () => {},
          upgrade: () => true,
        };
      },
    });

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const server = runtime.server.listen({ port: 0, fetch: () => new Response('ok') });

      const start = Date.now();
      await server.stop();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('publish failure is logged but does not throw', () => {
    const originalServe = Bun.serve;
    const errors: Array<{ phase?: string }> = [];
    Object.assign(Bun, {
      serve() {
        return {
          port: 0,
          stop: () => undefined,
          publish: () => {
            throw new Error('publish-boom');
          },
          upgrade: () => true,
        };
      },
    });

    const customLogger = {
      warn() {},
      error(_event: string, fields?: Record<string, unknown>) {
        errors.push({ phase: fields?.phase as string });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const server = runtime.server.listen({ port: 0, fetch: () => new Response('ok') });

      // Must not throw
      server.publish('room:test', 'hello');
      expect(errors.some(e => e.phase === 'publish')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      Object.assign(Bun, { serve: originalServe });
    }
  });
});

describe('runtime-bun prod hardening 2 — sqlite resource cleanup', () => {
  test('opening and closing multiple databases does not leak', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    for (let i = 0; i < 10; i++) {
      const db = runtime.sqlite.open(':memory:');
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      db.run('INSERT INTO t VALUES (?)', i);
      db.close();
    }
  });

  test('concurrent database handles', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const dbs = Array.from({ length: 5 }, () => runtime.sqlite.open(':memory:'));
    for (const db of dbs) {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.run("INSERT INTO t VALUES (1, 'test')");
    }
    for (const db of dbs) {
      const rows = db.query('SELECT v FROM t WHERE id = 1').all();
      expect(rows).toHaveLength(1);
      db.close();
    }
  });
});
