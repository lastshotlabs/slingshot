import { describe, expect, it } from 'bun:test';
import {
  createEntityAdapterTransformRegistry,
  createEntityPlugin,
  createEntityPluginHookRegistry,
} from '../../src';
import type { MultiEntityManifest } from '../../src/manifest/multiEntityManifest';
import {
  createMockAdapter,
  createMockApp,
  createMockBus,
  createMockFrameworkConfig,
  createMockInfraWithFactory,
  createMockSetupContext,
} from './helpers';

describe('manifest runtime ordering', () => {
  it('runs transforms, then afterAdapters hooks, then route application', async () => {
    const events: string[] = [];
    const runtime = {
      adapterTransforms: createEntityAdapterTransformRegistry(),
      hooks: createEntityPluginHookRegistry(),
    };

    runtime.adapterTransforms.register('note.transform', adapter => {
      events.push('transform');
      return Promise.resolve(adapter);
    });
    runtime.hooks.register('note.afterAdapters', () => {
      events.push('hook');
    });

    const manifest: MultiEntityManifest = {
      manifestVersion: 1,
      hooks: {
        afterAdapters: [{ handler: 'note.afterAdapters' }],
      },
      entities: {
        Note: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            text: { type: 'string' },
          },
          routes: { create: {}, list: {} },
          adapterTransforms: [{ handler: 'note.transform' }],
        },
      },
    };

    const fw = createMockFrameworkConfig();
    fw.storeInfra = createMockInfraWithFactory(
      () => createMockAdapter() as unknown as Record<string, unknown>,
    );
    const app = createMockApp(events);
    const bus = createMockBus();

    const plugin = createEntityPlugin({
      name: 'notes',
      manifest,
      manifestRuntime: runtime,
    });

    await plugin.setupRoutes!(createMockSetupContext(app, fw, bus));

    expect(events).toEqual(['transform', 'hook', 'route']);
  });
});
