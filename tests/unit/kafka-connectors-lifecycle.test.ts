import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createApp } from '../../src/app';
import { createServer } from '../../src/server';

type ShutdownRegistry = {
  callbacks: Map<string, (signal: string) => Promise<number>>;
  listeners: { sigterm: () => void; sigint: () => void } | null;
};

const SHUTDOWN_REGISTRY_SYMBOL = Symbol.for('slingshot.shutdownRegistry');

function getLastShutdownCallback(): (signal: string) => Promise<number> {
  const proc = process as unknown as Record<symbol, ShutdownRegistry | undefined>;
  const registry = proc[SHUTDOWN_REGISTRY_SYMBOL]!;
  const entries = [...registry.callbacks.values()];
  return entries[entries.length - 1]!;
}

const baseConfig = {
  meta: { name: 'Kafka Lifecycle Test App' },
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

let server: Awaited<ReturnType<typeof createServer>> | null = null;

afterEach(async () => {
  if (server) {
    try {
      server.stop(true);
    } catch {
      /* best-effort */
    }
    server = null;
  }
});

function createHandle() {
  const start = mock(async () => {});
  const stop = mock(async () => {});
  return {
    handle: {
      name: 'slingshot-kafka-connectors' as const,
      start,
      stop,
      health: () => ({
        started: true,
        inbound: [],
        outbound: [],
        pendingBufferSize: 0,
        droppedMessages: {
          totalDrops: 0,
          bufferFull: 0,
          attemptsExhausted: 0,
          inboundDeduped: 0,
          lastDropAt: null,
        },
      }),
      pendingBufferSize: () => 0,
    },
    start,
    stop,
  };
}

describe('kafka connector lifecycle plumbing', () => {
  test('createApp starts the handle and ctx.destroy stops it', async () => {
    const { handle, start, stop } = createHandle();
    const result = await createApp({
      ...baseConfig,
      kafkaConnectors: handle,
    });

    expect(result.ctx.kafkaConnectors).toBe(handle);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(result.ctx.bus);

    await result.ctx.destroy();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('createServer graceful shutdown stops the connector handle', async () => {
    const { handle, start, stop } = createHandle();

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      kafkaConnectors: handle,
    });

    expect(start).toHaveBeenCalledTimes(1);

    const exitCode = await getLastShutdownCallback()('SIGTERM');
    expect(exitCode).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);

    server = null;
  });
});
