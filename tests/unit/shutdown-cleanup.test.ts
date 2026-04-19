import { describe, expect, mock, test } from 'bun:test';
import type {
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';
import { runPluginTeardown } from '../../src/framework/runPluginLifecycle';

// Minimal config that avoids real DB connections.
const baseConfig = {
  routesDir: import.meta.dir + '/../fixtures/routes',
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: { rateLimit: { windowMs: 60_000, max: 100 } },
  logging: { onLog: () => {} },
};

// Plugins require at least one lifecycle method — add a no-op setupPost.
const noop = async () => {};

// ---------------------------------------------------------------------------
// Shutdown cleanup — verifies that teardown, bus shutdown, and plugin
// lifecycle are correctly called during graceful shutdown.
//
// We test the pieces that compose the shutdown handler (plugin teardown,
// event bus shutdown, app:shutdown emission) rather than triggering
// process signals, since sending SIGTERM in a test would kill the runner.
// ---------------------------------------------------------------------------

describe('shutdown cleanup', () => {
  test('plugin teardown is called during shutdown sequence', async () => {
    const teardownFn = mock(() => Promise.resolve());

    const plugin: SlingshotPlugin = {
      name: 'test-teardown',
      setupPost: noop,
      teardown: teardownFn,
    };

    const { app } = await createApp({
      ...baseConfig,
      plugins: [plugin],
    });

    const meta = getContext(app);
    expect(meta).toBeDefined();

    // Simulate the shutdown sequence from server.ts:
    // 1. Emit app:shutdown
    // 2. Call plugin teardowns via runPluginTeardown
    // 3. Shutdown bus
    const bus = meta!.bus;
    const plugins = meta!.plugins;

    bus.emit('app:shutdown', { signal: 'SIGTERM' });
    await runPluginTeardown([...plugins]);

    expect(teardownFn).toHaveBeenCalledTimes(1);
  });

  test('all plugin teardowns are called even when one throws', async () => {
    const teardown1 = mock(() => Promise.reject(new Error('teardown1 failed')));
    const teardown2 = mock(() => Promise.resolve());
    const teardown3 = mock(() => Promise.resolve());

    const plugins: SlingshotPlugin[] = [
      { name: 'plugin-a', setupPost: noop, teardown: teardown1 },
      { name: 'plugin-b', setupPost: noop, teardown: teardown2 },
      { name: 'plugin-c', setupPost: noop, teardown: teardown3 },
    ];

    const { app } = await createApp({
      ...baseConfig,
      plugins,
    });

    const meta = getContext(app)!;

    // runPluginTeardown isolates errors — all teardowns run regardless of failures
    await runPluginTeardown([...meta.plugins]).catch(() => {});

    expect(teardown1).toHaveBeenCalledTimes(1);
    expect(teardown2).toHaveBeenCalledTimes(1);
    expect(teardown3).toHaveBeenCalledTimes(1);
  });

  test('event bus emits app:shutdown with signal', async () => {
    const shutdownPayloads: Array<{ signal: string }> = [];

    const { app } = await createApp({ ...baseConfig, plugins: [] });
    const meta = getContext(app)!;
    const bus = meta.bus;

    bus.on('app:shutdown', payload => {
      shutdownPayloads.push(payload);
    });

    bus.emit('app:shutdown', { signal: 'SIGTERM' });

    expect(shutdownPayloads).toHaveLength(1);
    expect(shutdownPayloads[0].signal).toBe('SIGTERM');
  });

  test('event bus emits app:shutdown with SIGINT signal', async () => {
    const shutdownPayloads: Array<{ signal: string }> = [];

    const { app } = await createApp({ ...baseConfig, plugins: [] });
    const meta = getContext(app)!;
    const bus = meta.bus;

    bus.on('app:shutdown', payload => {
      shutdownPayloads.push(payload);
    });

    bus.emit('app:shutdown', { signal: 'SIGINT' });

    expect(shutdownPayloads).toHaveLength(1);
    expect(shutdownPayloads[0].signal).toBe('SIGINT');
  });

  test('event bus shutdown clears all listeners', async () => {
    const { app } = await createApp({ ...baseConfig, plugins: [] });
    const meta = getContext(app)!;
    const bus = meta.bus;

    const listener = mock(() => {});
    bus.on('app:shutdown', listener);

    // Shutdown the bus
    await bus.shutdown?.();

    // After shutdown, emitting should have no effect (listeners cleared)
    bus.emit('app:shutdown', { signal: 'SIGTERM' });
    expect(listener).toHaveBeenCalledTimes(0);
  });

  test('event bus shutdown waits for in-flight async shutdown listeners', async () => {
    const { app } = await createApp({ ...baseConfig, plugins: [] });
    const meta = getContext(app)!;
    const bus = meta.bus;
    const blocker = Promise.withResolvers<undefined>();
    let observed = false;

    bus.on('app:shutdown', async () => {
      await blocker.promise;
      observed = true;
    });

    bus.emit('app:shutdown', { signal: 'SIGTERM' });

    let shutdownResolved = false;
    const shutdownPromise = bus.shutdown?.().then(() => {
      shutdownResolved = true;
    });

    await Promise.resolve();
    expect(observed).toBe(false);
    expect(shutdownResolved).toBe(false);

    blocker.resolve(undefined);
    await shutdownPromise;

    expect(observed).toBe(true);
    expect(shutdownResolved).toBe(true);
  });

  test('full shutdown sequence runs in correct order', async () => {
    const order: string[] = [];

    const plugin: SlingshotPlugin = {
      name: 'ordered-plugin',
      setupPost: noop,
      teardown: mock(async () => {
        order.push('plugin:teardown');
      }),
    };

    const { app } = await createApp({ ...baseConfig, plugins: [plugin] });
    const meta = getContext(app)!;
    const bus = meta.bus;

    // Listen for shutdown event
    bus.on('app:shutdown', () => {
      order.push('bus:app:shutdown');
    });

    // Replicate shutdown sequence from server.ts:
    // 1. stopHeartbeat (no-op here since no WS)
    // 2. wsTransport disconnect (no-op)
    // 3. Emit app:shutdown
    bus.emit('app:shutdown', { signal: 'SIGTERM' });
    // 4. Plugin teardowns (reverse order, error-isolated)
    await runPluginTeardown([...meta.plugins]);
    // 5. Bus shutdown
    await bus.shutdown?.();

    order.push('bus:shutdown');

    expect(order).toEqual(['bus:app:shutdown', 'plugin:teardown', 'bus:shutdown']);
  });

  test('plugins without teardown do not cause errors', async () => {
    const pluginNoTeardown: SlingshotPlugin = { name: 'no-teardown', setupPost: noop };
    const pluginWithTeardown: SlingshotPlugin = {
      name: 'with-teardown',
      setupPost: noop,
      teardown: mock(() => Promise.resolve()),
    };

    const { app } = await createApp({
      ...baseConfig,
      plugins: [pluginNoTeardown, pluginWithTeardown],
    });

    const meta = getContext(app)!;

    // This should not throw even though pluginNoTeardown has no teardown
    await runPluginTeardown([...meta.plugins]);

    expect(pluginWithTeardown.teardown).toHaveBeenCalledTimes(1);
  });
});
