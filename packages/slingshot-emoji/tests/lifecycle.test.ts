import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import {
  PERMISSIONS_STATE_KEY,
  attachContext,
  createInProcessAdapter,
} from '@lastshotlabs/slingshot-core';
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
) {
  return {
    app: null,
    pluginState,
    upload: uploadAdapter ? { adapter: uploadAdapter } : undefined,
  };
}

describe('slingshot-emoji lifecycle', () => {
  test('setupMiddleware can resolve permissions from pluginState fallback', async () => {
    const app = new Hono();
    const pluginState = new Map([[PERMISSIONS_STATE_KEY, createTestPermissions()]]);
    const ctx = makeAppContext(pluginState);
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({});

    await plugin.setupMiddleware?.({
      app: app as never,
      config: {} as never,
      bus: createInProcessAdapter(),
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
    const ctx = makeAppContext(new Map());
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({});

    await expect(
      plugin.setupMiddleware?.({
        app: app as never,
        config: {} as never,
        bus: createInProcessAdapter(),
      }),
    ).rejects.toThrow('No permissions available');
  });

  test('setupPost warns when no storage adapter is configured', async () => {
    const app = new Hono();
    const ctx = makeAppContext();
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({ permissions: createTestPermissions() });
    const bus = createInProcessAdapter();

    await plugin.setupMiddleware?.({
      app: app as never,
      config: {} as never,
      bus,
    });
    await plugin.setupPost?.({
      app: app as never,
      config: {} as never,
      bus,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[slingshot-emoji] No storage adapter configured — emoji delete will not cascade to storage.',
    );
  });

  test('delete cascade warns and skips deletes when uploadKey is missing', async () => {
    const app = new Hono();
    const deleteMock = mock(async (_uploadKey: string) => {});
    const ctx = makeAppContext(new Map(), { delete: deleteMock });
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({ permissions: createTestPermissions() });
    const bus = createInProcessAdapter();

    await plugin.setupMiddleware?.({
      app: app as never,
      config: {} as never,
      bus,
    });
    await plugin.setupPost?.({
      app: app as never,
      config: {} as never,
      bus,
    });

    bus.emit('emoji:emoji.deleted', { id: 'emoji-1' } as never);
    await Promise.resolve();

    expect(deleteMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[slingshot-emoji] emoji:emoji.deleted payload missing uploadKey — skipping delete.',
    );
  });

  test('delete cascade removes uploaded files when uploadKey is present', async () => {
    const app = new Hono();
    const deleteMock = mock(async (_uploadKey: string) => {});
    const ctx = makeAppContext(new Map(), { delete: deleteMock });
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({
      permissions: createTestPermissions(),
      mountPath: '/custom-emoji',
    });
    const bus = createInProcessAdapter();

    await plugin.setupMiddleware?.({
      app: app as never,
      config: {} as never,
      bus,
    });
    await plugin.setupPost?.({
      app: app as never,
      config: {} as never,
      bus,
    });

    bus.emit('emoji:emoji.deleted', { id: 'emoji-1', uploadKey: 'uploads/emoji-1.png' } as never);
    await Promise.resolve();

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith('uploads/emoji-1.png');
    expect(createEmojiPlugin({ permissions: createTestPermissions() }).dependencies).toEqual([
      'slingshot-auth',
    ]);
  });

  test('teardown unregisters the delete cascade listener', async () => {
    const app = new Hono();
    const deleteMock = mock(async (_uploadKey: string) => {});
    const ctx = makeAppContext(new Map(), { delete: deleteMock });
    ctx.app = app;
    attachContext(app, ctx as never);

    const plugin = createEmojiPlugin({ permissions: createTestPermissions() });
    const bus = createInProcessAdapter();

    await plugin.setupMiddleware?.({
      app: app as never,
      config: {} as never,
      bus,
    });
    await plugin.setupPost?.({
      app: app as never,
      config: {} as never,
      bus,
    });
    await plugin.teardown?.();

    bus.emit('emoji:emoji.deleted', { id: 'emoji-1', uploadKey: 'uploads/emoji-1.png' } as never);
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
