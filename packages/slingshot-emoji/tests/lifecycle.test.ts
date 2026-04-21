import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import {
  PERMISSIONS_STATE_KEY,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  createInProcessAdapter,
} from '@lastshotlabs/slingshot-core';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { createTestPermissions } from '../../../tests/setup';
import { createEmojiPlugin } from '../src/plugin';

let warnSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = null;
});

function makeAppContext(
  pluginState = new Map<unknown, unknown>(),
  uploadAdapter?: { delete(uploadKey: string): Promise<void> },
  runtime?: {
    bus?: ReturnType<typeof createInProcessAdapter>;
    events?: ReturnType<typeof createEventPublisher>;
  },
) {
  return {
    app: null,
    pluginState,
    upload: uploadAdapter ? { adapter: uploadAdapter } : undefined,
    bus: runtime?.bus,
    events: runtime?.events,
  };
}

function createRuntime() {
  const bus = createInProcessAdapter();
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  return { bus, events };
}

function createFrameworkConfig() {
  const storeInfra = {};
  Reflect.set(storeInfra, RESOLVE_ENTITY_FACTORIES, createEntityFactories);
  const registeredEntities: unknown[] = [];

  return {
    resolvedStores: {
      sessions: 'memory',
      oauthState: 'memory',
      cache: 'memory',
      authStore: 'memory',
      sqlite: undefined,
    },
    storeInfra,
    entityRegistry: {
      register(config: unknown) {
        registeredEntities.push(config);
      },
      getAll() {
        return registeredEntities;
      },
      filter(predicate: (entity: unknown) => boolean) {
        return registeredEntities.filter(predicate);
      },
    },
  } as const;
}

describe('slingshot-emoji lifecycle', () => {
  test('setupMiddleware can resolve permissions from pluginState fallback', async () => {
    const app = new Hono();
    const pluginState = new Map([[PERMISSIONS_STATE_KEY, createTestPermissions()]]);
    const runtime = createRuntime();
    const ctx = makeAppContext(pluginState, undefined, runtime);
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({});

    await plugin.setupMiddleware?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });

    const response = await app.request('/emoji', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shortcode: 'Bad-Emoji',
        name: 'Bad Emoji',
        uploadKey: 'uploads/bad.png',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Invalid shortcode' });
    expect(plugin.dependencies).toEqual(['slingshot-auth', 'slingshot-permissions']);
  });

  test('setupMiddleware throws when permissions are unavailable', async () => {
    const app = new Hono();
    const runtime = createRuntime();
    const ctx = makeAppContext(new Map(), undefined, runtime);
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({});

    await expect(
      plugin.setupMiddleware?.({
        app: app as never,
        config: createFrameworkConfig() as never,
        bus: runtime.bus,
        events: runtime.events,
      }),
    ).rejects.toThrow('No permissions available');
  });

  test('setupPost warns when no storage adapter is configured', async () => {
    const app = new Hono();
    const runtime = createRuntime();
    const ctx = makeAppContext(new Map(), undefined, runtime);
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({ permissions: createTestPermissions() });

    await plugin.setupMiddleware?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
    await plugin.setupRoutes?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
    await plugin.setupPost?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[slingshot-emoji] No storage adapter configured — emoji delete will not cascade to storage.',
    );
  });

  test('delete cascade warns and skips deletes when uploadKey is missing', async () => {
    const app = new Hono();
    const deleteMock = mock(async () => {});
    const runtime = createRuntime();
    const ctx = makeAppContext(new Map(), { delete: deleteMock }, runtime);
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({ permissions: createTestPermissions() });

    await plugin.setupMiddleware?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
    await plugin.setupRoutes?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
    await plugin.setupPost?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });

    const deleteEventRaw = { id: 'emoji-1' };
    const deleteEvent = deleteEventRaw as unknown as never;
    runtime.bus.emit('emoji:emoji.deleted', deleteEvent);
    await Promise.resolve();

    expect(deleteMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[slingshot-emoji] emoji:emoji.deleted payload missing uploadKey — skipping delete.',
    );
  });

  test('delete cascade removes uploaded files when uploadKey is present', async () => {
    const app = new Hono();
    const deleteMock = mock(async () => {});
    const runtime = createRuntime();
    const ctx = makeAppContext(new Map(), { delete: deleteMock }, runtime);
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({
      permissions: createTestPermissions(),
      mountPath: '/custom-emoji',
    });
    await plugin.setupMiddleware?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
    await plugin.setupRoutes?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
    await plugin.setupPost?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });

    const deleteWithKeyEventRaw = { id: 'emoji-1', uploadKey: 'uploads/emoji-1.png' };
    const deleteWithKeyEvent = deleteWithKeyEventRaw as unknown as never;
    runtime.bus.emit('emoji:emoji.deleted', deleteWithKeyEvent);
    await Promise.resolve();

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith('uploads/emoji-1.png');
    expect(createEmojiPlugin({ permissions: createTestPermissions() }).dependencies).toEqual([
      'slingshot-auth',
    ]);
  });

  test('teardown unregisters the delete cascade listener', async () => {
    const app = new Hono();
    const deleteMock = mock(async () => {});
    const runtime = createRuntime();
    const ctx = makeAppContext(new Map(), { delete: deleteMock }, runtime);
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({ permissions: createTestPermissions() });

    await plugin.setupMiddleware?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
    await plugin.setupRoutes?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
    await plugin.setupPost?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
    await plugin.teardown?.();

    const deleteWithKeyEventRaw = { id: 'emoji-1', uploadKey: 'uploads/emoji-1.png' };
    const deleteWithKeyEvent = deleteWithKeyEventRaw as never;
    runtime.bus.emit('emoji:emoji.deleted', deleteWithKeyEvent);
    await Promise.resolve();

    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('warns when deprecated presignExpirySeconds is provided', () => {
    createEmojiPlugin({
      permissions: createTestPermissions(),
      presignExpirySeconds: 1800,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[slingshot-emoji] `presignExpirySeconds` is deprecated and ignored. Emoji asset URLs are owned by the upload/storage layer.',
    );
  });
});
