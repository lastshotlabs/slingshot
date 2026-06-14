import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import {
  InProcessAdapter,
  attachContext,
  createEntityRegistry,
  getContext,
  registerPluginCapabilities,
  resolveCapabilityValue,
} from '@lastshotlabs/slingshot-core';
import { runPackageLifecycle } from '@lastshotlabs/slingshot-entity/testing';
import { createNotificationsPackage } from '../../src/plugin';
import {
  NotificationsBuilderFactoryCap,
  NotificationsDeliveryRegistryCap,
  NotificationsHealthCap,
} from '../../src/public';
import { createNotificationsTestEvents } from '../../src/testing';

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
    capabilityProviders: new Map<string, string>(),
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
  };
  attachContext(app, ctx as never);
}

describe('createNotificationsPackage lifecycle', () => {
  test('setupRoutes mounts the SSE endpoint only when enabled', async () => {
    const enabledBus = new InProcessAdapter();
    const enabledEvents = createNotificationsTestEvents(enabledBus, {
      registerDefinitions: false,
    });

    const enabledApp = new Hono();
    attachMinimalContext(enabledApp, enabledBus);
    const enabledPlugin = createNotificationsPackage({
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
    const disabledPlugin = createNotificationsPackage({
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

  test('setupPost publishes capabilities, drives builder flow, and teardown removes listeners', async () => {
    const app = new Hono();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus, { registerDefinitions: false });
    attachMinimalContext(app, bus);

    const plugin = createNotificationsPackage({
      dispatcher: { enabled: false, intervalMs: 1000, maxPerTick: 10 },
      defaultPreferences: {
        pushEnabled: false,
        emailEnabled: true,
        inAppEnabled: true,
      },
    });

    // Drive the package's lifecycle the way `compilePackages()` does — the
    // helper walks entity modules, builds adapters from their `wiring`,
    // mounts the entity plugin, and runs the six lifecycle phases in
    // framework-equivalent order.
    await runPackageLifecycle(plugin, {
      app: app as never,
      config: createFrameworkConfig(),
      bus,
      events,
    });

    const ctx = getContext(app);
    // Drive the declarative capabilities slot the same way compilePackages
    // does at framework boot.
    await registerPluginCapabilities(ctx as never, plugin.name, plugin.capabilities.provides);

    const builderFactory = resolveCapabilityValue(ctx, NotificationsBuilderFactoryCap);
    const deliveryRegistry = resolveCapabilityValue(ctx, NotificationsDeliveryRegistryCap);
    expect(builderFactory).toBeDefined();
    expect(deliveryRegistry).toBeDefined();

    const deliver = mock(async () => {});
    deliveryRegistry?.register({ deliver } as never);

    const created = await builderFactory?.({ source: 'community' }).notify({
      userId: 'user-1',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-1',
    });
    await bus.drain();

    expect(created).toBeTruthy();
    expect(deliver).toHaveBeenCalledTimes(1);

    // Dispatcher health is observable through the NotificationsHealthCap capability.
    const getHealth = resolveCapabilityValue(ctx, NotificationsHealthCap);
    expect(getHealth).toBeDefined();
    const health = getHealth!();
    expect(health.details.adapterAvailable).toBe(true);
    expect(health.details.preferencesAdapterAvailable).toBe(true);
    expect(health.details.deliveryAdapterCount).toBe(1);

    await plugin.teardown?.();

    const postTeardownEvent = {
      notification: { userId: 'user-1', id: 'n-2' },
      preferences: { pushEnabled: true },
    };
    bus.emit('notifications:notification.created', postTeardownEvent as never);
    await bus.drain();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  test('continues delivering to later adapters when one adapter throws', async () => {
    const app = new Hono();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus, { registerDefinitions: false });
    attachMinimalContext(app, bus);

    const plugin = createNotificationsPackage({
      dispatcher: { enabled: false, intervalMs: 1000, maxPerTick: 10 },
    });

    await runPackageLifecycle(plugin, {
      app: app as never,
      config: createFrameworkConfig(),
      bus,
      events,
    });

    await registerPluginCapabilities(
      getContext(app) as never,
      plugin.name,
      plugin.capabilities.provides,
    );

    const deliveryRegistry = resolveCapabilityValue(
      getContext(app),
      NotificationsDeliveryRegistryCap,
    );
    expect(deliveryRegistry).toBeDefined();

    const firstDeliver = mock(async () => {
      throw new Error('adapter failed');
    });
    const secondDeliver = mock(async () => {});
    deliveryRegistry?.register({ deliver: firstDeliver } as never);
    deliveryRegistry?.register({ deliver: secondDeliver } as never);

    bus.emit('notifications:notification.created', {
      notification: {
        id: 'n-throw',
        userId: 'user-1',
        tenantId: null,
        source: 'community',
        type: 'community:mention',
      },
      preferences: { pushEnabled: true },
    } as never);
    await bus.drain();

    expect(firstDeliver).toHaveBeenCalledTimes(1);
    expect(secondDeliver).toHaveBeenCalledTimes(1);
  });

  test('rejects mountPath values without a leading slash', () => {
    expect(() => createNotificationsPackage({ mountPath: 'notifications' } as never)).toThrow(
      /mountPath must start with '\//i,
    );
  });
});
