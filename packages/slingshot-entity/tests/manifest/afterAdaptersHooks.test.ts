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

describe('manifest afterAdapters hooks', () => {
  it('hooks see transformed adapters rather than raw adapters', async () => {
    const runtime = {
      adapterTransforms: createEntityAdapterTransformRegistry(),
      hooks: createEntityPluginHookRegistry(),
    };

    runtime.adapterTransforms.register('note.flag', adapter =>
      Promise.resolve({
        ...adapter,
        create: async (input: unknown) => {
          const created = await adapter.create(input);
          return { ...(created as Record<string, unknown>), transformed: true };
        },
      }),
    );

    let sawTransformedAdapter = false;
    runtime.hooks.register('note.capture', async ({ adapters }) => {
      const created = await adapters.Note.create({ text: 'from-hook' });
      sawTransformedAdapter = (created as Record<string, unknown>).transformed === true;
    });

    const manifest: MultiEntityManifest = {
      manifestVersion: 1,
      hooks: {
        afterAdapters: [{ handler: 'note.capture' }],
      },
      entities: {
        Note: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            text: { type: 'string' },
          },
          routes: { create: {}, list: {} },
          adapterTransforms: [{ handler: 'note.flag' }],
        },
      },
    };

    const fw = createMockFrameworkConfig();
    fw.storeInfra = createMockInfraWithFactory(
      () => createMockAdapter() as unknown as Record<string, unknown>,
    );
    const app = createMockApp();
    const bus = createMockBus();

    const plugin = createEntityPlugin({
      name: 'notes',
      manifest,
      manifestRuntime: runtime,
    });

    await plugin.setupRoutes!(createMockSetupContext(app, fw, bus));

    expect(sawTransformedAdapter).toBe(true);
  });
});
