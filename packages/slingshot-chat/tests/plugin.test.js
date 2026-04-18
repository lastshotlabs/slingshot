// packages/slingshot-chat/tests/plugin.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatPlugin } from '../src/plugin';
import { createChatTestApp } from '../src/testing';

describe('createChatPlugin', () => {
  it('returns a SlingshotPlugin with correct name', () => {
    const plugin = createChatPlugin({ storeType: 'memory' });
    expect(plugin.name).toBe('slingshot-chat');
    expect(plugin.dependencies).toContain('slingshot-notifications');
  });
  it('has setupMiddleware, setupRoutes, setupPost lifecycle methods', () => {
    const plugin = createChatPlugin({ storeType: 'memory' });
    expect(typeof plugin.setupMiddleware).toBe('function');
    expect(typeof plugin.setupRoutes).toBe('function');
    expect(typeof plugin.setupPost).toBe('function');
  });
  it('throws on invalid config (wrong storeType)', () => {
    expect(() => createChatPlugin({ storeType: 'cassandra' })).toThrow();
  });
  it('each call returns an independent plugin instance', () => {
    const plugin1 = createChatPlugin({ storeType: 'memory' });
    const plugin2 = createChatPlugin({ storeType: 'memory' });
    expect(plugin1).not.toBe(plugin2);
  });
  it('does not throw on construction with valid config', () => {
    expect(() =>
      createChatPlugin({
        storeType: 'memory',
        mountPath: '/api/chat',
        permissions: { createRoom: ['admin'] },
        pageSize: 25,
        enablePresence: false,
      }),
    ).not.toThrow();
  });
  it('publishes a deeply frozen config into plugin state', async () => {
    const { state } = await createChatTestApp({
      encryption: {
        provider: 'aes-gcm',
        keyBase64: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64'),
      },
    });
    expect(Object.isFrozen(state.config)).toBe(true);
    expect(Object.isFrozen(state.config.permissions ?? {})).toBe(true);
    expect(Object.isFrozen(state.config.encryption ?? {})).toBe(true);
  });
});
