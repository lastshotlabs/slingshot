import { describe, expect, it } from 'bun:test';
import {
  createEntityAdapterTransformRegistry,
  createEntityHandlerRegistry,
  createEntityPlugin,
  resolveMultiEntityManifest,
} from '../../src';
import type { MultiEntityManifest } from '../../src/manifest/multiEntityManifest';
import type { BareEntityAdapter } from '../../src/routing/buildBareEntityRoutes';
import {
  createMockAdapter,
  createMockApp,
  createMockBus,
  createMockFrameworkConfig,
  createMockInfraWithCompositeFactory,
  createMockInfraWithFactory,
  createMockSetupContext,
} from './helpers';

describe('manifest adapter transforms', () => {
  it('runs transforms in declaration order', async () => {
    const order: string[] = [];
    const runtime = {
      adapterTransforms: createEntityAdapterTransformRegistry(),
    };

    runtime.adapterTransforms.register('note.first', adapter => {
      order.push('first');
      return Promise.resolve({
        ...adapter,
        create: async (input: unknown) => {
          const created = await adapter.create({
            ...(input as Record<string, unknown>),
            transformOrder: ['first'],
          });
          return created;
        },
      } satisfies BareEntityAdapter);
    });

    runtime.adapterTransforms.register('note.second', adapter => {
      order.push('second');
      return Promise.resolve({
        ...adapter,
        create: async (input: unknown) => {
          const created = await adapter.create(input);
          return {
            ...(created as Record<string, unknown>),
            transformOrder: [
              ...(((created as Record<string, unknown>).transformOrder as string[] | undefined) ??
                []),
              'second',
            ],
          };
        },
      } satisfies BareEntityAdapter);
    });

    const manifest: MultiEntityManifest = {
      manifestVersion: 1,
      entities: {
        Note: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            text: { type: 'string' },
          },
          routes: { create: {}, list: {} },
          adapterTransforms: [{ handler: 'note.first' }, { handler: 'note.second' }],
        },
      },
    };

    const baseAdapter = createMockAdapter();
    const fw = createMockFrameworkConfig();
    fw.storeInfra = createMockInfraWithFactory(() => ({ ...baseAdapter }));
    const app = createMockApp();
    const bus = createMockBus();

    let captured: BareEntityAdapter | undefined;
    const plugin = createEntityPlugin({
      name: 'notes',
      manifest,
      manifestRuntime: runtime,
      setupPost: ctx => {
        captured = ctx.adapters.Note;
      },
    });

    await plugin.setupRoutes!(createMockSetupContext(app, fw, bus));
    await plugin.setupPost!(createMockSetupContext(app, fw, bus));

    expect(order).toEqual(['first', 'second']);
    const created = await captured!.create({ text: 'hello' });
    expect((created as Record<string, unknown>).transformOrder).toEqual(['first', 'second']);
  });

  it('keeps the composite manifest path working with transforms', async () => {
    const runtime = {
      adapterTransforms: createEntityAdapterTransformRegistry(),
    };
    runtime.adapterTransforms.register('documents.decorate', adapter =>
      Promise.resolve({
        ...adapter,
        create: async (input: unknown) => {
          const created = await adapter.create(input);
          return { ...(created as Record<string, unknown>), decorated: true };
        },
      }),
    );

    const manifest: MultiEntityManifest = {
      manifestVersion: 1,
      entities: {
        Document: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            title: { type: 'string' },
          },
          routes: { create: {}, list: {} },
          adapterTransforms: [{ handler: 'documents.decorate' }],
        },
        Snapshot: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            documentId: { type: 'string' },
          },
          routes: { create: {}, list: {} },
        },
      },
      composites: {
        documentBundle: {
          entities: ['Document', 'Snapshot'],
          entityKey: 'Document',
        },
      },
    };

    const documentAdapter = createMockAdapter();
    const snapshotAdapter = createMockAdapter();
    const fw = createMockFrameworkConfig();
    fw.storeInfra = createMockInfraWithCompositeFactory(() => ({
      Document: documentAdapter,
      Snapshot: snapshotAdapter,
    }));
    const app = createMockApp();
    const bus = createMockBus();

    let captured: BareEntityAdapter | undefined;
    const plugin = createEntityPlugin({
      name: 'documents',
      manifest,
      manifestRuntime: runtime,
      setupPost: ctx => {
        captured = ctx.adapters.Document;
      },
    });

    await plugin.setupRoutes!(createMockSetupContext(app, fw, bus));
    await plugin.setupPost!(createMockSetupContext(app, fw, bus));

    const created = await captured!.create({ title: 'Draft' });
    expect((created as Record<string, unknown>).decorated).toBe(true);
    expect(app.routes).toHaveLength(1);
  });

  it('still resolves manifest custom handlers through the runtime handler registry', async () => {
    const runtime = {
      customHandlers: createEntityHandlerRegistry(),
    };
    runtime.customHandlers.register(
      'note.publish',
      params => () => (input: unknown) => Promise.resolve({ ok: true, params, input }),
    );

    const manifest: MultiEntityManifest = {
      manifestVersion: 1,
      entities: {
        Note: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            text: { type: 'string' },
          },
          operations: {
            publish: {
              kind: 'custom',
              handler: 'note.publish',
              params: { audience: 'followers' },
            },
          },
        },
      },
    };

    const resolved = resolveMultiEntityManifest(manifest, runtime.customHandlers);
    const publishOp = resolved.entities.Note.operations.publish as unknown as Record<
      string,
      unknown
    >;

    expect(publishOp.kind).toBe('custom');
    expect(typeof publishOp.memory).toBe('function');
    const handler = (publishOp.memory as (driver: unknown) => (input: unknown) => Promise<unknown>)(
      null,
    );
    const result = await handler({ noteId: 'note-1' });
    expect(result).toEqual({
      ok: true,
      params: { audience: 'followers' },
      input: { noteId: 'note-1' },
    });
  });
});
