import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { getContext } from '@lastshotlabs/slingshot-core';
import {
  GAME_ENGINE_PLUGIN_STATE_KEY,
  createGameEnginePackage,
  defineGame,
} from '@lastshotlabs/slingshot-game-engine';
import {
  INTERACTIONS_PLUGIN_STATE_KEY,
  createInteractionsPackage,
} from '@lastshotlabs/slingshot-interactions';
import {
  NotificationsBuilderFactoryCap,
  createNotificationsPackage,
} from '@lastshotlabs/slingshot-notifications';
import { createPermissionsPackage } from '@lastshotlabs/slingshot-permissions';
import { createTestApp } from '../setup';

const createdApps: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdApps.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

const lifecycleGame = defineGame({
  name: 'lifecycle-test',
  display: 'Lifecycle Test',
  minPlayers: 1,
  maxPlayers: 4,
  rules: z.object({}),
  sync: { mode: 'event' },
  phases: {
    lobby: {
      next: null,
      advance: 'manual',
    },
  },
  handlers: {},
});

describe('package plugin lifecycle', () => {
  test('slingshot-game-engine publishes session controls instead of raw active runtime state', async () => {
    const app = await createTestApp({
      packages: [
        createGameEnginePackage({
          games: [lifecycleGame],
        }),
      ],
    });
    const ctx = getContext(app);
    createdApps.push(ctx);

    const state = ctx.pluginState.get(GAME_ENGINE_PLUGIN_STATE_KEY) as
      | { sessionControls?: { has(sessionId: string): boolean; list(): readonly unknown[] } }
      | undefined;

    expect(state).toBeDefined();
    expect(state?.sessionControls).toBeDefined();
    expect(state?.sessionControls?.has('missing')).toBeFalse();
    expect(state?.sessionControls?.list()).toEqual([]);
    expect('activeRuntimes' in ((state ?? {}) as Record<string, unknown>)).toBeFalse();
  });

  test('slingshot-notifications publishes plugin state, mounts SSE, and unregisters its listener on teardown', async () => {
    const plugin = createNotificationsPackage({
      dispatcher: {
        enabled: false,
        intervalMs: 30_000,
        maxPerTick: 10,
      },
    });

    const app = await createTestApp({
      packages: [plugin],
    });
    const ctx = getContext(app);
    createdApps.push(ctx);

    const slot = ctx.pluginState.get(
      'slingshot:package:capabilities:slingshot-notifications',
    ) as { builderFactory?: unknown } | undefined;
    expect(slot?.builderFactory).toBeDefined();
    expect(NotificationsBuilderFactoryCap.contract).toBe('slingshot-notifications');

    const response = await app.request('/notifications/sse');
    expect(response.status).toBe(401);

    const offSpy = spyOn(
      ctx.bus as { off(event: string, handler: (payload: unknown) => void): void },
      'off',
    );
    await plugin.teardown?.();

    expect(offSpy).toHaveBeenCalledTimes(1);
    expect(offSpy.mock.calls[0]?.[0]).toBe('notifications:notification.created');
  });

  test('slingshot-interactions fails fast without permissions state', async () => {
    const plugin = {
      ...createInteractionsPackage({
        handlers: {},
        rateLimit: { windowMs: 60_000, max: 20 },
      }),
      dependencies: ['slingshot-auth'],
    };

    try {
      await createTestApp({
        plugins: [plugin],
      });
      throw new Error('Expected createTestApp() to reject without permissions state.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        '[slingshot-interactions] Permissions state not found. Register createPermissionsPackage() first.',
      );
    }
  });

  test('slingshot-interactions publishes plugin state and mounts the dispatch route', async () => {
    const app = await createTestApp({
      packages: [
        createPermissionsPackage(),
        createInteractionsPackage({
          handlers: {},
          rateLimit: { windowMs: 60_000, max: 20 },
        }),
      ],
    });
    const ctx = getContext(app);
    createdApps.push(ctx);

    expect(ctx.pluginState.get(INTERACTIONS_PLUGIN_STATE_KEY)).toBeDefined();

    const response = await app.request('/interactions/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });
});
