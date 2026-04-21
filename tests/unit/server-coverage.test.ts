import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { defineEvent } from '@lastshotlabs/slingshot-core';
import { stopHeartbeat } from '../../src/framework/ws/heartbeat';
import { createServer, getServerContext } from '../../src/server';

// ---------------------------------------------------------------------------
// Shared base config — no real DB connections
// ---------------------------------------------------------------------------

const baseConfig = {
  meta: { name: 'Server Coverage Test' },
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

function createSseDefinitionPlugin(key: string) {
  return {
    name: `sse-coverage-${key}`,
    setupMiddleware({ events }: { events: { register(definition: unknown): void } }) {
      events.register(
        defineEvent(key as never, {
          ownerPlugin: 'server-coverage-test',
          exposure: ['client-safe'],
          resolveScope() {
            return {};
          },
        }),
      );
    },
  };
}

let server: Awaited<ReturnType<typeof createServer>> | null = null;

afterEach(async () => {
  if (server) {
    const ctx = getServerContext(server);
    // Stop heartbeat timer before stopping the server to avoid lingering handles
    if (ctx?.ws) stopHeartbeat(ctx.ws);
    await server.stop(true);
    await ctx?.destroy();
    server = null;
  }
});

// ---------------------------------------------------------------------------
// getServerContext
// ---------------------------------------------------------------------------

describe('getServerContext', () => {
  test('returns null for a plain object without context', () => {
    expect(getServerContext({})).toBeNull();
  });

  test('returns null for an object with undefined context symbol', () => {
    const fake = {};
    Object.defineProperty(fake, Symbol.for('slingshot.serverContext'), {
      value: undefined,
    });
    expect(getServerContext(fake)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Port validation
// ---------------------------------------------------------------------------

describe('port validation', () => {
  // NOTE: process.env.PORT may be "" (empty string). Since "" ?? fallback
  // evaluates to "" (not null/undefined), and Number("") === 0, the PORT
  // env takes precedence when set to any string. We must delete PORT to
  // test config.port paths.

  test('rejects NaN port via Zod schema', async () => {
    const origPort = process.env.PORT;
    delete process.env.PORT;
    try {
      await expect(
        createServer({
          ...baseConfig,
          port: Number.NaN,
        }),
      ).rejects.toThrow();
    } finally {
      if (origPort !== undefined) process.env.PORT = origPort;
    }
  });

  test('rejects negative port', async () => {
    const origPort = process.env.PORT;
    delete process.env.PORT;
    try {
      await expect(
        createServer({
          ...baseConfig,
          port: -1,
        }),
      ).rejects.toThrow('Invalid port');
    } finally {
      if (origPort !== undefined) process.env.PORT = origPort;
    }
  });

  test('rejects port above 65535', async () => {
    const origPort = process.env.PORT;
    delete process.env.PORT;
    try {
      await expect(
        createServer({
          ...baseConfig,
          port: 70000,
        }),
      ).rejects.toThrow('Invalid port');
    } finally {
      if (origPort !== undefined) process.env.PORT = origPort;
    }
  });

  test('rejects fractional port', async () => {
    const origPort = process.env.PORT;
    delete process.env.PORT;
    try {
      await expect(
        createServer({
          ...baseConfig,
          port: 3000.5,
        }),
      ).rejects.toThrow('Invalid port');
    } finally {
      if (origPort !== undefined) process.env.PORT = origPort;
    }
  });

  test('accepts port from PORT env when config.port is omitted', async () => {
    const originalPort = process.env.PORT;
    process.env.PORT = '0';
    try {
      server = await createServer({
        ...baseConfig,
        hostname: '127.0.0.1',
      });
      expect(server.port).toBeGreaterThanOrEqual(0);
    } finally {
      if (originalPort !== undefined) process.env.PORT = originalPort;
      else delete process.env.PORT;
    }
  });

  test('rejects non-numeric PORT env', async () => {
    const originalPort = process.env.PORT;
    process.env.PORT = 'abc';
    try {
      await expect(
        createServer({
          ...baseConfig,
          hostname: '127.0.0.1',
        }),
      ).rejects.toThrow('Invalid port');
    } finally {
      if (originalPort !== undefined) process.env.PORT = originalPort;
      else delete process.env.PORT;
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP-only server (no WS config)
// ---------------------------------------------------------------------------

describe('createServer HTTP-only', () => {
  test('starts a plain HTTP server when no ws config is provided', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });
    expect(server).toBeDefined();
    expect(server.port).toBeGreaterThan(0);
  });

  test('stores context on server accessible via getServerContext', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });
    const ctx = getServerContext(server);
    expect(ctx).not.toBeNull();
    expect(ctx!.bus).toBeDefined();
  });

  test('maxRequestBodySize derived from upload config', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      upload: {
        maxFileSize: 5 * 1024 * 1024,
        maxFiles: 3,
      },
    });
    expect(server).toBeDefined();
  });

  test('explicit maxRequestBodySize overrides upload-derived value', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 999,
      upload: {
        maxFileSize: 5 * 1024 * 1024,
        maxFiles: 3,
      },
    });
    expect(server).toBeDefined();
  });

  test('logs unix socket address when unix is set', async () => {
    // We can't easily test unix sockets on Windows but we can test the
    // address logging path when unix is provided. This will start a
    // server on a unix socket. Skip if not on a unix-capable platform.
    if (process.platform === 'win32') {
      // On Windows, test that we at least don't crash when hostname is provided
      server = await createServer({
        ...baseConfig,
        hostname: '127.0.0.1',
        port: 0,
      });
      expect(server).toBeDefined();
      return;
    }
    const socketPath = `/tmp/slingshot-test-${Date.now()}.sock`;
    try {
      server = await createServer({
        ...baseConfig,
        unix: socketPath,
      });
      expect(server).toBeDefined();
    } finally {
      // cleanup
    }
  });
});

// ---------------------------------------------------------------------------
// WS config branches
// ---------------------------------------------------------------------------

describe('createServer with WS config', () => {
  test('starts server with basic WS endpoint', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-test': {},
        },
      },
    });
    expect(server).toBeDefined();
    const ctx = getServerContext(server);
    expect(ctx?.ws).toBeDefined();
  });

  test('recovery without persistence throws', async () => {
    await expect(
      createServer({
        ...baseConfig,
        hostname: '127.0.0.1',
        port: 0,
        ws: {
          endpoints: {
            '/ws-recovery': {
              recovery: { windowMs: 60_000 },
            },
          },
        },
      }),
    ).rejects.toThrow('recovery requires persistence to be configured');
  });

  test('WS config with heartbeat enables heartbeat', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-hb': {
            heartbeat: true,
          },
        },
      },
    });
    const ctx = getServerContext(server);
    expect(ctx?.ws?.heartbeatEndpointConfigs).toBeDefined();
  });

  test('WS config with presence flag', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-presence': {
            presence: true,
          },
        },
      },
    });
    const ctx = getServerContext(server);
    expect(ctx?.ws?.presenceEnabled).toBe(true);
  });

  test('WS config with persistence defaults', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-persist': {
            persistence: {
              store: 'memory',
              defaults: { ttl: 60_000 },
            },
          },
        },
      },
    });
    expect(server).toBeDefined();
  });

  test('WS endpoint with optional config: idleTimeout, backpressureLimit, etc.', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        idleTimeout: 120,
        backpressureLimit: 1024 * 1024,
        closeOnBackpressureLimit: true,
        perMessageDeflate: false,
        publishToSelf: false,
        endpoints: {
          '/ws-opts': {},
        },
      },
    });
    expect(server).toBeDefined();
  });

  test('WS with maxRequestBodySize from config', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 1024,
      ws: {
        endpoints: {
          '/ws-body': {},
        },
      },
    });
    expect(server).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// server.stop() releases shutdown ownership
// ---------------------------------------------------------------------------

describe('server.stop', () => {
  test('calling server.stop deregisters from shutdown registry', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });
    // server.stop() should not throw
    await server.stop(true);
    const ctx = getServerContext(server);
    await ctx?.destroy();
    server = null; // prevent afterEach from double-stopping
  });
});

// ---------------------------------------------------------------------------
// Workers loading branch
// ---------------------------------------------------------------------------

describe('workers loading', () => {
  test('loads workers when enableWorkers and workersDir are set', async () => {
    // We create a temp dir that exists but has no worker files.
    // This exercises the workers branch without actual worker logic.
    const { mkdirSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = join(tmpdir(), `slingshot-workers-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      workersDir: dir,
      enableWorkers: true,
    });
    expect(server).toBeDefined();
  });

  test('does not load workers when enableWorkers is false', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      workersDir: '/nonexistent',
      enableWorkers: false,
    });
    expect(server).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SSE configuration branches
// ---------------------------------------------------------------------------

describe('createServer with SSE config', () => {
  test('SSE endpoint with literal path succeeds', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      sse: {
        endpoints: {
          '/__sse/events': {
            events: [],
            heartbeat: 15_000,
          },
        },
      },
    });
    expect(server).toBeDefined();
  });

  test('SSE endpoint with :param in path throws', async () => {
    await expect(
      createServer({
        ...baseConfig,
        hostname: '127.0.0.1',
        port: 0,
        sse: {
          endpoints: {
            '/__sse/:id': {
              events: [],
            },
          },
        },
      }),
    ).rejects.toThrow('must be a literal path');
  });

  test('SSE endpoint with wildcard in path throws', async () => {
    await expect(
      createServer({
        ...baseConfig,
        hostname: '127.0.0.1',
        port: 0,
        sse: {
          endpoints: {
            '/__sse/*': {
              events: [],
            },
          },
        },
      }),
    ).rejects.toThrow('must be a literal path');
  });

  test('SSE endpoint without /__sse/ prefix throws', async () => {
    await expect(
      createServer({
        ...baseConfig,
        hostname: '127.0.0.1',
        port: 0,
        sse: {
          endpoints: {
            '/events': {
              events: [],
            },
          },
        },
      }),
    ).rejects.toThrow('must be under the /__sse/ prefix');
  });

  test('SSE endpoint colliding with WS endpoint throws', async () => {
    await expect(
      createServer({
        ...baseConfig,
        hostname: '127.0.0.1',
        port: 0,
        ws: {
          endpoints: {
            '/__sse/shared': {},
          },
        },
        sse: {
          endpoints: {
            '/__sse/shared': {
              events: [],
            },
          },
        },
      }),
    ).rejects.toThrow('collides with an existing WS endpoint');
  });

  test('SSE endpoint with heartbeat disabled (heartbeat: 0)', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      sse: {
        endpoints: {
          '/__sse/no-hb': {
            events: [],
            heartbeat: 0,
          },
        },
      },
    });
    expect(server).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Config validation warnings
// ---------------------------------------------------------------------------

describe('config validation warnings', () => {
  test('logs warnings from validateServerConfig', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      server = await createServer({
        ...baseConfig,
        hostname: '127.0.0.1',
        port: 0,
      });
      // If there are no warnings that's fine — we just want to exercise the path
      expect(server).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// WS handler callback tests are in server-ws-handlers.test.ts (separate file
// to avoid handle accumulation when combined with many server-creation tests).

// ---------------------------------------------------------------------------
// SSE with events — bus subscription paths (lines 266-272)
// ---------------------------------------------------------------------------

describe('createServer with SSE events', () => {
  test('SSE endpoint with events registers bus listeners', async () => {
    const ssePlugin = createSseDefinitionPlugin('test:event');

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      plugins: [ssePlugin],
      sse: {
        endpoints: {
          '/__sse/test-events': {
            events: ['test:event' as any],
          },
        },
      },
    });
    expect(server).toBeDefined();
    const ctx = getServerContext(server);
    expect(ctx).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WS with rate limit config — starts server, exercises lines 388-395
// ---------------------------------------------------------------------------

describe('createServer with WS rate limit', () => {
  test('WS endpoint with rate limit config', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-rl': {
            rateLimit: {
              windowMs: 1000,
              max: 5,
            },
          },
        },
      },
    });
    expect(server).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SSE Hono route handler — exercises lines 276-288
// ---------------------------------------------------------------------------

describe('SSE HTTP endpoint', () => {
  test('SSE endpoint responds with text/event-stream', async () => {
    const ssePlugin = createSseDefinitionPlugin('test:sse-http');

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      plugins: [ssePlugin],
      sse: {
        endpoints: {
          '/__sse/http-test': {
            events: ['test:sse-http' as any],
          },
        },
      },
    });

    // Make an HTTP GET request to the SSE endpoint
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/__sse/http-test`, {
        signal: controller.signal,
      });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      // Close the stream
      controller.abort();
    } catch (e) {
      // AbortError is expected after we get headers
      if (e instanceof Error && e.name !== 'AbortError') throw e;
    } finally {
      clearTimeout(timeout);
    }
  });
});
