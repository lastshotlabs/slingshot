import { describe, expect, it } from 'bun:test';
import {
  type EventDefinitionRegistry,
  createEventDefinitionRegistry,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import {
  type WebhookRuntimeAdapter,
  createWebhooksManifestRuntime,
} from '../../src/manifest/runtime';
import type { WebhookAttempt, WebhookEndpointSubscription } from '../../src/types/models';

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'test:webhook.visible': { tenantId: string; id: string };
    'test:webhook.other': { tenantId: string; id: string };
  }
}

type EndpointRecord = {
  id: string;
  ownerType?: 'tenant' | 'user' | 'app' | 'system';
  ownerId?: string;
  tenantId?: string | null;
  url: string;
  secret: string;
  subscriptions?: WebhookEndpointSubscription[];
  events?: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type DeliveryRecord = {
  id: string;
  tenantId?: string | null;
  endpointId: string;
  event: string;
  eventId: string;
  occurredAt: string;
  subscriber: {
    ownerType: 'tenant' | 'user' | 'app' | 'system';
    ownerId: string;
    tenantId?: string | null;
  };
  sourceScope?: { tenantId?: string | null } | null;
  projectedPayload: string;
  status: 'pending' | 'delivered' | 'failed' | 'dead';
  attempts: number;
  nextRetryAt?: string | null;
  lastAttempt?: WebhookAttempt;
  createdAt: string;
  updatedAt: string;
};

function createDefinitions(): EventDefinitionRegistry {
  const definitions = createEventDefinitionRegistry();
  definitions.register(
    defineEvent('test:webhook.visible', {
      ownerPlugin: 'test-webhooks',
      exposure: ['tenant-webhook'],
      resolveScope(payload) {
        return { tenantId: payload.tenantId };
      },
    }),
  );
  definitions.register(
    defineEvent('test:webhook.other', {
      ownerPlugin: 'test-webhooks',
      exposure: ['tenant-webhook'],
      resolveScope(payload) {
        return { tenantId: payload.tenantId };
      },
    }),
  );
  return definitions;
}

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
  manifestRuntimeOptions?: Parameters<typeof createWebhooksManifestRuntime>[1];
}): Promise<{
  runtime: WebhookRuntimeAdapter;
  endpointCrud: BareEntityAdapter;
}> {
  let runtimeAdapter: WebhookRuntimeAdapter | undefined;
  const manifestRuntime = createWebhooksManifestRuntime(adapter => {
    runtimeAdapter = adapter;
  }, options?.manifestRuntimeOptions);

  const endpointAdapter =
    options?.endpointAdapter ??
    (createEndpointBaseAdapter(options?.endpoints ?? []) as BareEntityAdapter);
  const deliveryAdapter =
    options?.deliveryAdapter ??
    (createDeliveryBaseAdapter(options?.deliveries ?? []) as BareEntityAdapter);

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
    endpointCrud: transformedEndpointAdapter,
  };
}

describe('webhooks manifest runtime', () => {
  it('paginates through filtered-out delivery statuses without returning empty pages', async () => {
    const { runtime } = await setupRuntime({
      deliveries: [
        {
          id: 'delivery-1',
          endpointId: 'endpoint-1',
          event: 'test:webhook.visible',
          eventId: 'evt-1',
          occurredAt: '2026-01-01T00:00:00.000Z',
          subscriber: { ownerType: 'tenant', ownerId: 'tenant-a', tenantId: 'tenant-a' },
          sourceScope: { tenantId: 'tenant-a' },
          projectedPayload: '{"ok":true}',
          status: 'delivered',
          attempts: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'delivery-2',
          endpointId: 'endpoint-1',
          event: 'test:webhook.visible',
          eventId: 'evt-2',
          occurredAt: '2026-01-01T00:00:01.000Z',
          subscriber: { ownerType: 'tenant', ownerId: 'tenant-a', tenantId: 'tenant-a' },
          sourceScope: { tenantId: 'tenant-a' },
          projectedPayload: '{"ok":true}',
          status: 'dead',
          attempts: 2,
          createdAt: '2026-01-01T00:00:01.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
        {
          id: 'delivery-3',
          endpointId: 'endpoint-1',
          event: 'test:webhook.visible',
          eventId: 'evt-3',
          occurredAt: '2026-01-01T00:00:02.000Z',
          subscriber: { ownerType: 'tenant', ownerId: 'tenant-a', tenantId: 'tenant-a' },
          sourceScope: { tenantId: 'tenant-a' },
          projectedPayload: '{"ok":true}',
          status: 'delivered',
          attempts: 1,
          createdAt: '2026-01-01T00:00:02.000Z',
          updatedAt: '2026-01-01T00:00:02.000Z',
        },
        {
          id: 'delivery-4',
          endpointId: 'endpoint-1',
          event: 'test:webhook.visible',
          eventId: 'evt-4',
          occurredAt: '2026-01-01T00:00:03.000Z',
          subscriber: { ownerType: 'tenant', ownerId: 'tenant-a', tenantId: 'tenant-a' },
          sourceScope: { tenantId: 'tenant-a' },
          projectedPayload: '{"ok":true}',
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

  it('migrates legacy endpoint rows across paginated scans before delivery wiring starts', async () => {
    const endpoints: EndpointRecord[] = Array.from({ length: 501 }, (_, index) => ({
      id: `endpoint-${index + 1}`,
      tenantId: 'tenant-a',
      url: `https://example.com/${index + 1}`,
      secret: `secret-${index + 1}`,
      events: index === 500 ? ['test:webhook.visible'] : ['test:webhook.other'],
      enabled: true,
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const { runtime } = await setupRuntime({ endpoints });

    await runtime.initializeGovernance(createDefinitions());

    expect(endpoints[500]).toMatchObject({
      ownerType: 'tenant',
      ownerId: 'tenant-a',
      subscriptions: [{ event: 'test:webhook.visible', exposure: 'tenant-webhook' }],
      events: [],
    });
  });

  it('normalizes management writes to concrete subscriptions and rejects legacy events input', async () => {
    const records: EndpointRecord[] = [];
    const { runtime, endpointCrud } = await setupRuntime({ endpoints: records });
    await runtime.initializeGovernance(createDefinitions());

    const created = (await endpointCrud.create({
      id: 'endpoint-1',
      tenantId: 'tenant-a',
      url: 'https://example.com/hook',
      secret: 'super-secret',
      subscriptions: [{ pattern: 'test:webhook.*' }],
      enabled: true,
    })) as {
      subscriptions: WebhookEndpointSubscription[];
      secret: string;
    };

    expect(created.subscriptions).toEqual([
      { event: 'test:webhook.other', exposure: 'tenant-webhook', sourcePattern: 'test:webhook.*' },
      {
        event: 'test:webhook.visible',
        exposure: 'tenant-webhook',
        sourcePattern: 'test:webhook.*',
      },
    ]);
    expect(created.secret).toBe('****');
    expect(records[0]?.subscriptions).toEqual(created.subscriptions);

    await expect(
      endpointCrud.create({
        id: 'endpoint-2',
        tenantId: 'tenant-a',
        url: 'https://example.com/hook',
        secret: 'super-secret',
        events: ['test:webhook.visible'],
      }),
    ).rejects.toThrow('legacy "events" input is no longer supported');
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

  it('routes endpoint secret writes through a custom SecretEncryptor and reads them back', async () => {
    // Track encrypt/decrypt calls so we can prove the runtime is using the
    // injected encryptor (rather than the default plaintext passthrough).
    const calls: { op: 'encrypt' | 'decrypt'; value: string }[] = [];
    const PREFIX = 'kms:';
    const encryptor = {
      encrypt: async (plaintext: string) => {
        calls.push({ op: 'encrypt', value: plaintext });
        return PREFIX + Buffer.from(plaintext).toString('base64');
      },
      decrypt: async (stored: string) => {
        calls.push({ op: 'decrypt', value: stored });
        if (!stored.startsWith(PREFIX)) return stored;
        return Buffer.from(stored.slice(PREFIX.length), 'base64').toString('utf8');
      },
    };

    const definitions = createDefinitions();
    const records: EndpointRecord[] = [];
    const { runtime, endpointCrud } = await setupRuntime({
      endpoints: records,
      manifestRuntimeOptions: { encryptor },
    });
    await runtime.initializeGovernance(definitions);

    const created = (await endpointCrud.create({
      url: 'https://example.com/hook',
      secret: 'super-secret-value',
      enabled: true,
      ownerType: 'tenant',
      ownerId: 'tenant-a',
      tenantId: 'tenant-a',
      subscriptions: [{ event: 'test:webhook.visible' }],
    })) as { id: string; secret: string };

    // Stored secret on disk must be the encrypted form, never the plaintext.
    const storedRow = records.find(r => r.id === created.id);
    expect(storedRow).toBeDefined();
    expect(storedRow!.secret.startsWith(PREFIX)).toBe(true);
    expect(storedRow!.secret).not.toContain('super-secret-value');
    expect(calls.some(c => c.op === 'encrypt' && c.value === 'super-secret-value')).toBe(true);

    // Sanitized response from the create path must mask the secret.
    expect(created.secret).toBe('****');

    // getEndpoint reveals the plaintext for HMAC signing by routing through
    // the decryptor.
    const revealed = await runtime.getEndpoint(created.id);
    expect(revealed?.secret).toBe('super-secret-value');
    expect(calls.some(c => c.op === 'decrypt' && c.value === storedRow!.secret)).toBe(true);

    // listEnabledEndpoints must also decrypt.
    const enabled = await runtime.listEnabledEndpoints();
    const matching = enabled.find(e => e.id === created.id);
    expect(matching?.secret).toBe('super-secret-value');
  });
});
