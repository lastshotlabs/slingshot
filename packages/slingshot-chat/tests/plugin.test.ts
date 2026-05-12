// packages/slingshot-chat/tests/plugin.test.ts
import { describe, expect, it } from 'bun:test';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createChatPackage } from '../src/plugin';
import { CHAT_PLUGIN_STATE_KEY } from '../src/state';
import { createChatTestApp } from '../src/testing';

describe('createChatPackage', () => {
  it('returns a SlingshotPackageDefinition with the correct name', () => {
    const pkg = createChatPackage({ storeType: 'memory' });
    expect(pkg.kind).toBe('package');
    expect(pkg.name).toBe(CHAT_PLUGIN_STATE_KEY);
    expect(pkg.dependencies).toContain('slingshot-notifications');
    expect(pkg.dependencies).toContain('slingshot-permissions');
  });

  it('has setupMiddleware, setupRoutes, setupPost lifecycle hooks', () => {
    const pkg = createChatPackage({ storeType: 'memory' });
    expect(typeof pkg.setupMiddleware).toBe('function');
    expect(typeof pkg.setupRoutes).toBe('function');
    expect(typeof pkg.setupPost).toBe('function');
  });

  it('declares all 10 chat entities', () => {
    const pkg = createChatPackage({ storeType: 'memory' });
    expect(pkg.entities).toHaveLength(10);
    const entityNames = pkg.entities.map(e => e.entityName).sort();
    expect(entityNames).toEqual(
      [
        'Block',
        'FavoriteRoom',
        'Message',
        'MessageReaction',
        'Pin',
        'ReadReceipt',
        'Reminder',
        'Room',
        'RoomInvite',
        'RoomMember',
      ].sort(),
    );
  });

  it('publishes the ChatInteractionsPeerCap capability', () => {
    const pkg = createChatPackage({ storeType: 'memory' });
    expect(pkg.capabilities.provides.length).toBeGreaterThan(0);
  });

  it('throws on invalid config (wrong storeType)', () => {
    expect(() => createChatPackage({ storeType: 'cassandra' as never })).toThrow();
  });

  it('each call returns an independent package instance', () => {
    const pkg1 = createChatPackage({ storeType: 'memory' });
    const pkg2 = createChatPackage({ storeType: 'memory' });
    expect(pkg1).not.toBe(pkg2);
  });

  it('does not throw on construction with valid config', () => {
    expect(() =>
      createChatPackage({
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

  it('self-wires WS incoming handlers onto the mountPath endpoint', async () => {
    const { app } = await createChatTestApp();
    const ctx = getContext(app);
    expect(ctx.wsEndpoints?.['/chat']).toBeDefined();
    expect(ctx.wsEndpoints?.['/chat']?.incoming).toBeDefined();
  });

  it('registers chat push formatters through the optional peer boundary', async () => {
    const registered = new Map<string, unknown>();
    // Mock the typed `PushFormatterRegistryCap` slot directly so chat's
    // `resolveCapabilityValue(ctx, PushFormatterRegistryCap)` returns the stub.
    const peersPluginState = new Map<string, unknown>([
      [
        'slingshot:package:capabilities:slingshot-push',
        {
          formatterRegistry: {
            registerFormatter(type: string, formatter: unknown) {
              registered.set(type, formatter);
            },
          },
        },
      ],
    ]);

    await createChatTestApp(
      {},
      {
        peersPluginState,
        peersCapabilityProviders: [
          ['slingshot-push:formatterRegistry', 'slingshot-push'],
        ],
      },
    );

    expect(registered.has('chat:mention')).toBe(true);
    expect(registered.has('chat:reply')).toBe(true);
    expect(registered.has('chat:dm')).toBe(true);
    expect(registered.has('chat:invite')).toBe(true);
    expect(registered.has('chat:poll')).toBe(true);
  });
});
