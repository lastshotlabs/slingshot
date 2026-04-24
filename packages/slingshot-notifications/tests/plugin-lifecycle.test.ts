import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import {
  InProcessAdapter,
  attachContext,
  createEntityRegistry,
  getContext,
} from '@lastshotlabs/slingshot-core';
import { createNotificationsPlugin } from '../src/plugin';
import { NOTIFICATIONS_PLUGIN_STATE_KEY } from '../src/state';
import type { NotificationsPluginState } from '../src/state';
import { createNotificationsTestEvents } from '../src/testing';

function createFrameworkConfig() {
  const cfg = {
    resolvedStores: { authStore: 'memory' },
    storeInfra: {},
    entityRegistry: createEntityRegistry(),
  };
  return cfg as never;
}

function attachMinimalContext(app: Hono, bus: InProcessAdapter) {
  const ctx = {
    app,
    pluginState: new Map(),
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
  };
  attachContext(app, ctx as never);
}

describe('createNotificationsPlugin lifecycle', () => {
  test('setupPost fails loudly when setupRoutes never resolved the entity adapters', async () => {
    const app = new Hono();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus, { registerDefinitions: false });
    attachMinimalContext(app, bus);

    const plugin = createNotificationsPlugin({
      dispatcher: { enabled: false, intervalMs: 1000, maxPerTick: 10 },
    });

    await plugin.setupMiddleware?.({
      app: app as never,
      config: createFrameworkConfig(),
      bus,
      events,
    });
    await expect(
      plugin.setupPost?.({
        app: app as never,
        config: createFrameworkConfig(),
        bus,
        events,
      }),
    ).rejects.toThrow('Entity adapters were not resolved during setupRoutes');
  });

  test('setupRoutes mounts the SSE endpoint only when enabled', async () => {
    const enabledBus = new InProcessAdapter();
    const enabledEvents = createNotificationsTestEvents(enabledBus, {
      registerDefinitions: false,
    });

    const enabledApp = new Hono();
    attachMinimalContext(enabledApp, enabledBus);
    const enabledPlugin = createNotificationsPlugin({
      dispatcher: { enabled: false, intervalMs: 1000, maxPerTick: 10 },
      sseEnabled: true,
      ssePath: '/stream',
    });
    await enabledPlugin.setupMiddleware?.({
      app: enabledApp as never,
      config: createFrameworkConfig(),
      bus: enabledBus,
      events: enabledEvents,
    });
    await enabledPlugin.setupRoutes?.({
      app: enabledApp as never,
      config: createFrameworkConfig(),
      bus: enabledBus,
      events: enabledEvents,
    });

    const enabledResponse = await enabledApp.request('/stream');
    expect(enabledResponse.status).toBe(401);
    expect(await enabledResponse.json()).toEqual({ error: 'Unauthorized' });

    const disabledBus = new InProcessAdapter();
    const disabledEvents = createNotificationsTestEvents(disabledBus, {
      registerDefinitions: false,
    });
    const disabledApp = new Hono();
    attachMinimalContext(disabledApp, disabledBus);
    const disabledPlugin = createNotificationsPlugin({
      dispatcher: { enabled: false, intervalMs: 1000, maxPerTick: 10 },
      sseEnabled: false,
    });
    await disabledPlugin.setupMiddleware?.({
      app: disabledApp as never,
      config: createFrameworkConfig(),
      bus: disabledBus,
      events: disabledEvents,
    });
    await disabledPlugin.setupRoutes?.({
      app: disabledApp as never,
      config: createFrameworkConfig(),
      bus: disabledBus,
      events: disabledEvents,
    });

    expect((await disabledApp.request('/notifications/sse')).status).toBe(404);
  });

  test('setupPost publishes plugin state, drives builder flow, and teardown removes listeners', async () => {
    const app = new Hono();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus, { registerDefinitions: false });
    attachMinimalContext(app, bus);

    const plugin = createNotificationsPlugin({
      dispatcher: { enabled: false, intervalMs: 1000, maxPerTick: 10 },
      defaultPreferences: {
        pushEnabled: false,
        emailEnabled: true,
        inAppEnabled: true,
      },
    });

    await plugin.setupMiddleware?.({
      app: app as never,
      config: createFrameworkConfig(),
      bus,
      events,
    });
    await plugin.setupRoutes?.({
      app: app as never,
      config: createFrameworkConfig(),
      bus,
      events,
    });
    await plugin.setupPost?.({
      app: app as never,
      config: createFrameworkConfig(),
      bus,
      events,
    });

    const state = getContext(app).pluginState.get(NOTIFICATIONS_PLUGIN_STATE_KEY) as
      | NotificationsPluginState
      | undefined;
    expect(state).toBeDefined();
    expect(Object.isFrozen(state)).toBe(true);
    expect(state?.config.mountPath).toBe('/notifications');

    const deliver = mock(async () => {});
    const adapter = { deliver };
    state?.registerDeliveryAdapter(adapter as never);

    const created = await state?.createBuilder({ source: 'community' }).notify({
      userId: 'user-1',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-1',
    });
    await bus.drain();

    expect(created).toBeTruthy();
    expect(deliver).toHaveBeenCalledTimes(1);

    const persisted = await state?.notifications.listByUser({ 'actor.id': 'user-1' });
    expect(persisted?.items).toHaveLength(1);
    expect(persisted?.items[0]?.source).toBe('community');

    await expect(state?.dispatcher.tick()).resolves.toBe(0);

    await plugin.teardown?.();

    const postTeardownEvent = {
      notification: { userId: 'user-1', id: 'n-2' },
      preferences: { pushEnabled: true },
    };
    bus.emit('notifications:notification.created', postTeardownEvent as never);
    await bus.drain();

    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
