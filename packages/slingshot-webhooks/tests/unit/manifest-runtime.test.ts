import { describe, expect, it } from 'bun:test';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import {
  type WebhookRuntimeAdapter,
  createWebhooksManifestRuntime,
} from '../../src/manifest/runtime';
import type { WebhookAttempt } from '../../src/types/models';

type EndpointRecord = {
  id: string;
  tenantId?: string | null;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type DeliveryRecord = {
  id: string;
  tenantId?: string | null;
  endpointId: string;
  event: string;
  payload: unknown;
  status: 'pending' | 'delivered' | 'failed' | 'dead';
  attempts: number;
  nextRetryAt?: string | null;
  lastAttempt?: WebhookAttempt;
  createdAt: string;
  updatedAt: string;
};

function paginate<T>(
  items: T[],
  cursor: string | undefined,
  limit: number | undefined,
): {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
} {
  const start = cursor ? Number(cursor) : 0;
  const pageSize = limit ?? items.length;
  const pageItems = items.slice(start, start + pageSize);
  const nextIndex = start + pageItems.length;
  return {
    items: pageItems,
    nextCursor: nextIndex < items.length ? String(nextIndex) : undefined,
    hasMore: nextIndex < items.length,
  };
}

function createEndpointBaseAdapter(records: EndpointRecord[]): BareEntityAdapter {
  return {
    async create(input: unknown) {
      const record = input as EndpointRecord;
      records.push(record);
      return record;
    },
    async getById(id: string) {
      return records.find(record => record.id === id) ?? null;
    },
    async list(opts: { filter?: unknown; limit?: number; cursor?: string }) {
      const filter = (opts.filter ?? {}) as { enabled?: boolean };
      const filtered = records.filter(record =>
        filter.enabled === undefined ? true : record.enabled === filter.enabled,
      );
      return paginate(filtered, opts.cursor, opts.limit);
    },
    async update(id: string, input: unknown) {
      const index = records.findIndex(record => record.id === id);
      if (index < 0) return null;
      records[index] = { ...records[index]!, ...(input as Partial<EndpointRecord>) };
      return records[index]!;
    },
    async delete() {
      return true;
    },
    async findForEvent(input: { event: string }) {
      return records.filter(record => record.events.includes(input.event));
    },
  };
}

function createDeliveryBaseAdapter(records: DeliveryRecord[]): BareEntityAdapter {
  return {
    async create(input: unknown) {
      const record = input as DeliveryRecord;
      records.push(record);
      return record;
    },
    async getById(id: string) {
      return records.find(record => record.id === id) ?? null;
    },
    async list(opts: { filter?: unknown; limit?: number; cursor?: string }) {
      const filter = (opts.filter ?? {}) as { endpointId?: string };
      const filtered = records.filter(record =>
        filter.endpointId === undefined ? true : record.endpointId === filter.endpointId,
      );
      return paginate(filtered, opts.cursor, opts.limit);
    },
    async update(id: string, input: unknown) {
      const index = records.findIndex(record => record.id === id);
      if (index < 0) return null;
      records[index] = { ...records[index]!, ...(input as Partial<DeliveryRecord>) };
      return records[index]!;
    },
    async delete() {
      return true;
    },
    async transition(input: {
      id: string;
      status: DeliveryRecord['status'];
      attempts?: number;
      nextRetryAt?: string | null;
      lastAttempt?: WebhookAttempt;
    }) {
      const index = records.findIndex(record => record.id === input.id);
      if (index < 0) {
        throw new Error('Delivery not found');
      }
      records[index] = {
        ...records[index]!,
        status: input.status,
        attempts: input.attempts ?? records[index]!.attempts,
        nextRetryAt: input.nextRetryAt ?? null,
        lastAttempt: input.lastAttempt,
      };
      return records[index]!;
    },
  };
}

async function setupRuntime(options?: {
  endpoints?: EndpointRecord[];
  deliveries?: DeliveryRecord[];
  endpointAdapter?: BareEntityAdapter;
  deliveryAdapter?: BareEntityAdapter;
}): Promise<{
  runtime: WebhookRuntimeAdapter;
  manifestRuntime: ReturnType<typeof createWebhooksManifestRuntime>;
}> {
  let runtimeAdapter: WebhookRuntimeAdapter | undefined;
  const manifestRuntime = createWebhooksManifestRuntime(adapter => {
    runtimeAdapter = adapter;
  });

  const endpointAdapter =
    options?.endpointAdapter ??
    (createEndpointBaseAdapter([...(options?.endpoints ?? [])]) as BareEntityAdapter);
  const deliveryAdapter =
    options?.deliveryAdapter ??
    (createDeliveryBaseAdapter([...(options?.deliveries ?? [])]) as BareEntityAdapter);

  const transformCtx = {
    app: {} as never,
    bus: {} as never,
    pluginName: 'webhooks',
    entityName: 'WebhookEndpoint',
    adapters: {},
  };

  const transformedEndpointAdapter = await manifestRuntime.adapterTransforms!.resolve(
    'webhooks.endpoint.runtime',
  )(endpointAdapter, transformCtx as never);
  const transformedDeliveryAdapter = await manifestRuntime.adapterTransforms!.resolve(
    'webhooks.delivery.runtime',
  )(deliveryAdapter, { ...transformCtx, entityName: 'WebhookDelivery' } as never);

  await manifestRuntime.hooks!.resolve('webhooks.captureAdapters')({
    app: {} as never,
    bus: {} as never,
    pluginName: 'webhooks',
    adapters: {
      WebhookEndpoint: transformedEndpointAdapter,
      WebhookDelivery: transformedDeliveryAdapter,
    },
    permissions: null,
  });

  if (!runtimeAdapter) {
    throw new Error('failed to capture webhook runtime adapter');
  }

  return {
    runtime: runtimeAdapter,
    manifestRuntime,
  };
}

describe('webhooks manifest runtime', () => {
  it('paginates through filtered-out delivery statuses without returning empty pages', async () => {
    const { runtime } = await setupRuntime({
      deliveries: [
        {
          id: 'delivery-1',
          endpointId: 'endpoint-1',
          event: 'evt.delivered.1',
          payload: { ok: true },
          status: 'delivered',
          attempts: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'delivery-2',
          endpointId: 'endpoint-1',
          event: 'evt.dead.1',
          payload: { ok: true },
          status: 'dead',
          attempts: 2,
          createdAt: '2026-01-01T00:00:01.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
        {
          id: 'delivery-3',
          endpointId: 'endpoint-1',
          event: 'evt.delivered.2',
          payload: { ok: true },
          status: 'delivered',
          attempts: 1,
          createdAt: '2026-01-01T00:00:02.000Z',
          updatedAt: '2026-01-01T00:00:02.000Z',
        },
        {
          id: 'delivery-4',
          endpointId: 'endpoint-1',
          event: 'evt.dead.2',
          payload: { ok: true },
          status: 'dead',
          attempts: 3,
          createdAt: '2026-01-01T00:00:03.000Z',
          updatedAt: '2026-01-01T00:00:03.000Z',
        },
      ],
    });

    const firstPage = await runtime.listDeliveries({ status: 'dead', limit: 1 });
    expect(firstPage.items.map(item => item.id)).toEqual(['delivery-2']);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeString();

    const secondPage = await runtime.listDeliveries({
      status: 'dead',
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items.map(item => item.id)).toEqual(['delivery-4']);
    expect(secondPage.hasMore).toBe(false);
  });

  it('scans all enabled endpoints for event matches instead of stopping at the first 500', async () => {
    const endpoints: EndpointRecord[] = Array.from({ length: 501 }, (_, index) => ({
      id: `endpoint-${index + 1}`,
      tenantId: null,
      url: `https://example.com/${index + 1}`,
      secret: `secret-${index + 1}`,
      events: index === 500 ? ['event.match'] : ['event.other'],
      enabled: true,
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const { manifestRuntime } = await setupRuntime({ endpoints });

    const handlerFactory = manifestRuntime.customHandlers!.resolve(
      'webhooks.endpoint.findForEvent',
    ) as () => (input: unknown) => Promise<EndpointRecord[]>;
    const handler = handlerFactory();

    const matches = await handler({ event: 'event.match' });
    expect(matches.map(match => match.id)).toEqual(['endpoint-501']);
  });

  it('fails fast when endpoint runtime hooks are incomplete', async () => {
    const manifestRuntime = createWebhooksManifestRuntime(() => {});
    const endpointAdapter = {
      async create(data: unknown) {
        return data;
      },
      async getById() {
        return null;
      },
      async list() {
        return { items: [], hasMore: false };
      },
      async update() {
        return null;
      },
      async delete() {
        return true;
      },
    } satisfies BareEntityAdapter;
    const deliveryAdapter = createDeliveryBaseAdapter([]);

    const transformedEndpointAdapter = await manifestRuntime.adapterTransforms!.resolve(
      'webhooks.endpoint.runtime',
    )(endpointAdapter, {
      app: {} as never,
      bus: {} as never,
      pluginName: 'webhooks',
      entityName: 'WebhookEndpoint',
      adapters: {},
    } as never);
    const transformedDeliveryAdapter = await manifestRuntime.adapterTransforms!.resolve(
      'webhooks.delivery.runtime',
    )(deliveryAdapter, {
      app: {} as never,
      bus: {} as never,
      pluginName: 'webhooks',
      entityName: 'WebhookDelivery',
      adapters: {},
    } as never);

    expect(() =>
      manifestRuntime.hooks!.resolve('webhooks.captureAdapters')({
        app: {} as never,
        bus: {} as never,
        pluginName: 'webhooks',
        adapters: {
          WebhookEndpoint: transformedEndpointAdapter,
          WebhookDelivery: transformedDeliveryAdapter,
        },
        permissions: null,
      }),
    ).toThrow('[slingshot-webhooks] endpoint adapter runtime hooks are missing');
  });

  it('fails fast when delivery runtime hooks are incomplete', async () => {
    const manifestRuntime = createWebhooksManifestRuntime(() => {});
    const endpointAdapter = createEndpointBaseAdapter([]);
    const deliveryAdapter = {
      async create(data: unknown) {
        return data;
      },
      async getById() {
        return null;
      },
      async list() {
        return { items: [], hasMore: false };
      },
      async update() {
        return null;
      },
      async delete() {
        return true;
      },
    } satisfies BareEntityAdapter;

    const transformedEndpointAdapter = await manifestRuntime.adapterTransforms!.resolve(
      'webhooks.endpoint.runtime',
    )(endpointAdapter, {
      app: {} as never,
      bus: {} as never,
      pluginName: 'webhooks',
      entityName: 'WebhookEndpoint',
      adapters: {},
    } as never);
    const transformedDeliveryAdapter = await manifestRuntime.adapterTransforms!.resolve(
      'webhooks.delivery.runtime',
    )(deliveryAdapter, {
      app: {} as never,
      bus: {} as never,
      pluginName: 'webhooks',
      entityName: 'WebhookDelivery',
      adapters: {},
    } as never);

    expect(() =>
      manifestRuntime.hooks!.resolve('webhooks.captureAdapters')({
        app: {} as never,
        bus: {} as never,
        pluginName: 'webhooks',
        adapters: {
          WebhookEndpoint: transformedEndpointAdapter,
          WebhookDelivery: transformedDeliveryAdapter,
        },
        permissions: null,
      }),
    ).toThrow('[slingshot-webhooks] delivery adapter runtime hooks are missing');
  });
});
