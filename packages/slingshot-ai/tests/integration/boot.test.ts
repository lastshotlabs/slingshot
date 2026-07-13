/**
 * Boot: the package must come up inside a real app and publish its capabilities.
 *
 * The capability assertions here are the ones that catch the framework's
 * nastiest package-authoring trap: `publishPackageRuntimeState` runs a second,
 * DECLARATIVE pass at the top of `setupPost`, which wipes anything a package
 * registered imperatively during `setupMiddleware`. A package that publishes
 * only from `setupMiddleware` therefore boots fine, passes a middleware-phase
 * test, and then has no capabilities at all by the time an app goes to use them.
 * `slingshot-ai` publishes from BOTH hooks; this test is what keeps that true.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { PACKAGE_CAPABILITIES_PREFIX, getContext } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../../../../tests/setup';
import { AI_PACKAGE_NAME, createAiPackage } from '../../src/plugin';
import { createFakeAiProvider, scriptedModerator } from '../../src/testing';
import type { AiClient, AiModerator, AiUsageReader } from '../../src/types';

const createdApps: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdApps.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

function track(app: unknown): void {
  createdApps.push((app as { ctx: { destroy(): Promise<void> } }).ctx);
}

/**
 * Read the package-capabilities slot the framework publishes into plugin state.
 * This is the same slot `ctx.capabilities.require(...)` reads from inside a
 * request — we go at it directly so the assertion doesn't need an HTTP round
 * trip through auth.
 */
function publishedCaps(app: object): Record<string, unknown> | undefined {
  const state = getContext(app).pluginState as Map<string, unknown>;
  return state.get(`${PACKAGE_CAPABILITIES_PREFIX}${AI_PACKAGE_NAME}`) as
    | Record<string, unknown>
    | undefined;
}

describe('slingshot-ai boot', () => {
  test('publishes client, moderation, and usage capabilities', async () => {
    const app = await createTestApp({
      packages: [
        createAiPackage({
          providers: { test: { provider: createFakeAiProvider({ responses: ['hi'] }) } },
          defaultProvider: 'test',
          moderation: { moderator: scriptedModerator() },
        }),
      ],
    });
    track(app);

    // All three, AFTER the full lifecycle has run — including the declarative
    // re-publish at the top of setupPost that wipes imperative registrations.
    const caps = publishedCaps(app);
    expect(Object.keys(caps ?? {}).sort()).toEqual(['client', 'moderation', 'usage']);

    const client = caps?.client as AiClient;
    const moderator = caps?.moderation as AiModerator;
    const usage = caps?.usage as AiUsageReader;

    expect(moderator.policies()).toBeDefined();

    // And they're live, not just present.
    const providers = client.providers();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe('test');
    expect(providers[0]?.isDefault).toBe(true);

    const result = await client.generate({ messages: [{ role: 'user', content: 'hello' }] });
    expect(result.value).toBe('hi');
    expect(result.provider).toBe('test');

    const spend = await usage.spend();
    expect(spend.state).toBe('ok');
  });

  test('an app that does not install the package is unaffected', async () => {
    // The additive-only guarantee, as a test: no package, no AI capabilities,
    // no boot failure, nothing published.
    const app = await createTestApp({});
    track(app);

    expect(publishedCaps(app)).toBeUndefined();
  });

  test('fails fast at boot when a provider is configured with a secret that does not exist', async () => {
    // A keyless provider must fail at STARTUP, not on the first player's first
    // request an hour into a party.
    const boot = createTestApp({
      packages: [
        createAiPackage({
          providers: { anthropic: { kind: 'anthropic', apiKeySecret: 'NO_SUCH_SECRET' } },
          defaultProvider: 'anthropic',
        }),
      ],
    });

    await expect(boot).rejects.toThrow(/NO_SUCH_SECRET/);
  });

  test('rejects a defaultProvider that is not configured', async () => {
    expect(() =>
      createAiPackage({
        providers: { test: { provider: createFakeAiProvider() } },
        defaultProvider: 'nope',
      }),
    ).toThrow(/nope/);
  });
});
