import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
import { emojiPluginConfigSchema } from '../src/types';

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

describe('slingshot-emoji plugin config', () => {
  test('presignExpirySeconds deprecation warning is emitted', () => {
    createEmojiPlugin({
      permissions: createTestPermissions(),
      presignExpirySeconds: 3600,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[slingshot-emoji] `presignExpirySeconds` is deprecated and ignored. Emoji asset URLs are owned by the upload/storage layer.',
    );
  });

  test('no warning emitted when presignExpirySeconds is omitted', () => {
    createEmojiPlugin({
      permissions: createTestPermissions(),
    });

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('presignExpirySeconds'));
  });

  test('config schema accepts valid config', () => {
    const result = emojiPluginConfigSchema.safeParse({
      mountPath: '/custom-emoji',
    });
    expect(result.success).toBe(true);
  });

  test('config schema rejects mountPath without leading slash', () => {
    const result = emojiPluginConfigSchema.safeParse({
      mountPath: 'emoji',
    });
    expect(result.success).toBe(false);
  });

  test('dependencies include slingshot-permissions when permissions not provided', () => {
    const plugin = createEmojiPlugin({});
    expect(plugin.dependencies).toEqual(['slingshot-auth', 'slingshot-permissions']);
  });

  test('dependencies exclude slingshot-permissions when permissions provided', () => {
    const plugin = createEmojiPlugin({ permissions: createTestPermissions() });
    expect(plugin.dependencies).toEqual(['slingshot-auth']);
  });
});

describe('slingshot-emoji parsed body caching', () => {
  test('shortcode validation middleware caches parsedBody for downstream handlers', async () => {
    // Verify the middleware behavior in isolation: register the shortcode
    // validation middleware manually (same logic as the plugin) then check
    // that parsedBody is available downstream.
    const app = new Hono();

    const SHORTCODE_RE = /^[a-z0-9_]{2,32}$/;
    let capturedBody: unknown = undefined;

    app.use('/emoji', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      const rawBody: unknown = await c.req.json().catch(() => null);
      c.set('parsedBody' as never, rawBody as never);
      const shortcode =
        rawBody != null && typeof rawBody === 'object' && 'shortcode' in rawBody
          ? (rawBody as { shortcode: unknown }).shortcode
          : undefined;
      if (typeof shortcode === 'string' && !SHORTCODE_RE.test(shortcode)) {
        return c.json({ error: 'Invalid shortcode' }, 400);
      }
      return next();
    });

    app.post('/emoji', async c => {
      capturedBody = (c as any).get('parsedBody');
      return c.json({ ok: true });
    });

    const payload = { shortcode: 'valid_code', name: 'Test', uploadKey: 'uploads/test.png' };
    await app.request('/emoji', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(capturedBody).toEqual(payload);
  });

  test('parsedBody is null when request body is not valid JSON', async () => {
    const app = new Hono();
    let capturedBody: unknown = 'sentinel';

    app.use('/emoji', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      const rawBody: unknown = await c.req.json().catch(() => null);
      c.set('parsedBody' as never, rawBody as never);
      return next();
    });

    app.post('/emoji', async c => {
      capturedBody = (c as any).get('parsedBody');
      return c.json({ ok: true });
    });

    await app.request('/emoji', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json!!!',
    });

    expect(capturedBody).toBeNull();
  });

  test('GET requests skip body parsing and pass through', async () => {
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

    let handlerReached = false;
    app.get('/emoji', async c => {
      handlerReached = true;
      return c.json({ ok: true });
    });

    const res = await app.request('/emoji', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(handlerReached).toBe(true);
  });
});

describe('slingshot-emoji permission guarding', () => {
  test('plugin resolves permissions from pluginState when not provided explicitly', async () => {
    const app = new Hono();
    const pluginState = new Map([[PERMISSIONS_STATE_KEY, createTestPermissions()]]);
    const runtime = createRuntime();
    const ctx = makeAppContext(pluginState, undefined, runtime);
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({});

    // Should not throw — permissions found via pluginState
    await plugin.setupMiddleware?.({
      app: app as never,
      config: createFrameworkConfig() as never,
      bus: runtime.bus,
      events: runtime.events,
    });
  });

  test('throws when permissions are missing from both config and pluginState', async () => {
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
});
