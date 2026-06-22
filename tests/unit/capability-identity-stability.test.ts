// Identity-stability regression test for capability providers.
//
// The framework's `publishPackageRuntimeState` runs twice per package (once at
// `setupMiddleware`, once at `setupPost`) and calls every provider's
// `resolve()` each time, republishing the cap slot. If a provider allocates a
// fresh object/Proxy per `resolve()` call, consumers reading the same
// capability at different lifecycle phases observe different `===` identities
// for what is logically the same capability.
//
// This test asserts each of the recently-fixed packages returns the *same*
// reference from two successive `resolve()` calls. The provider closure is
// the only piece under test — no app bootstrap is required.
import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { SlingshotPackageDefinition } from '@lastshotlabs/slingshot-core';
import { createGameEnginePackage, defineGame } from '@lastshotlabs/slingshot-game-engine';
import { createInteractionsPackage } from '@lastshotlabs/slingshot-interactions';
import { createOrchestrationPackage } from '@lastshotlabs/slingshot-orchestration';
import { createOrganizationsPackage } from '@lastshotlabs/slingshot-organizations';
import { createPushPackage } from '@lastshotlabs/slingshot-push';
import { createSsrPackage } from '@lastshotlabs/slingshot-ssr';
import { createPollsPackage } from '../../packages/slingshot-polls/src/index';
import { createTestSsrConfig } from '../../packages/slingshot-ssr/src/testing';

async function assertStableIdentity(pkg: SlingshotPackageDefinition): Promise<void> {
  expect(pkg.capabilities.provides.length).toBeGreaterThan(0);
  for (const provider of pkg.capabilities.provides) {
    const first = await provider.resolve({ packageName: pkg.name });
    const second = await provider.resolve({ packageName: pkg.name });
    // Two successive resolve() calls — as the framework does at setupMiddleware
    // + setupPost — must return the same reference.
    expect(first).toBe(second);
  }
}

describe('capability identity stability across eager publishes', () => {
  test('slingshot-game-engine providers return the same reference per resolve', async () => {
    const game = defineGame({
      name: 'identity-test',
      display: 'Identity Test',
      minPlayers: 1,
      maxPlayers: 2,
      rules: z.object({}),
      phases: { lobby: { next: null, advance: 'manual' } },
      handlers: {},
    });
    const pkg = createGameEnginePackage({ games: [game] });
    await assertStableIdentity(pkg);
  });

  test('slingshot-interactions providers return the same reference per resolve', async () => {
    const pkg = createInteractionsPackage({});
    await assertStableIdentity(pkg);
  });

  test('slingshot-orchestration providers return the same reference per resolve', async () => {
    const adapter = {
      registerTask: mock(() => {}),
      registerWorkflow: mock(() => {}),
      runTask: mock(async () => ({ id: 'run-1', result: async () => ({}) })),
      runWorkflow: mock(async () => ({ id: 'run-1', result: async () => ({}) })),
      getRun: mock(async () => null),
      cancelRun: mock(async () => {}),
      start: mock(async () => {}),
      shutdown: mock(async () => {}),
    };
    const pkg = createOrchestrationPackage({
      adapter: adapter as never,
      tasks: [],
      routes: false,
    });
    await assertStableIdentity(pkg);
  });

  test('slingshot-polls providers return the same reference per resolve', async () => {
    const pkg = createPollsPackage({ closeCheckIntervalMs: 0 });
    await assertStableIdentity(pkg);
  });

  test('slingshot-ssr providers return the same reference per resolve', async () => {
    const pkg = createSsrPackage(createTestSsrConfig());
    await assertStableIdentity(pkg);
  });

  test('slingshot-push providers return the same reference per resolve', async () => {
    const pkg = createPushPackage({
      enabledPlatforms: ['android'],
      mountPath: '/push',
      android: {
        serviceAccount: {
          project_id: 'test-project',
          client_email: 'firebase@test.iam.gserviceaccount.com',
          private_key: 'k',
        },
      },
    });
    await assertStableIdentity(pkg);
  });

  test('slingshot-organizations providers return the same reference per resolve', async () => {
    const pkg = createOrganizationsPackage();
    await assertStableIdentity(pkg);
  });
});
