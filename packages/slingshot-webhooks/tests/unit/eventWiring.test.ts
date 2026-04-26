import { describe, expect, it, mock } from 'bun:test';
import type {
  SlingshotEventBus,
  SlingshotEvents,
  SubscriptionOpts,
} from '@lastshotlabs/slingshot-core';
import {
  createEventDefinitionRegistry,
  createEventPublisher,
  createInProcessAdapter,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import { wireEventSubscriptions } from '../../src/lib/eventWiring';
import { createWebhookMemoryQueue } from '../../src/queues/memory';
import type { WebhookAdapter } from '../../src/types/adapter';
import type { WebhookPluginConfig } from '../../src/types/config';
import type { WebhookDelivery, WebhookEndpoint } from '../../src/types/models';

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'test:webhook.tenant.created': {
      tenantId: string;
      documentId: string;
    };
    'test:webhook.user.login': {
      tenantId?: string | null;
      userId: string;
    };
  }
}

function createEvents(bus: ReturnType<typeof createInProcessAdapter>): SlingshotEvents {
  const definitions = createEventDefinitionRegistry();
  const events = createEventPublisher({ definitions, bus });

  events.register(
    defineEvent('test:webhook.tenant.created', {
      ownerPlugin: 'test-webhooks',
      exposure: ['tenant-webhook'],
      resolveScope(payload) {
        return {
          tenantId: payload.tenantId,
          resourceType: 'document',
          resourceId: payload.documentId,
        };
      },
    }),
  );

  events.register(
    defineEvent('test:webhook.user.login', {
      ownerPlugin: 'test-webhooks',
      exposure: ['user-webhook'],
      resolveScope(payload) {
        return {
          tenantId: payload.tenantId ?? null,
          userId: payload.userId,
          actorId: payload.userId,
        };
      },
    }),
  );

  return events;
}

function createAdapter(seedEndpoints: WebhookEndpoint[] = []): WebhookAdapter {
  const endpoints = [...seedEndpoints];
  const deliveries: WebhookDelivery[] = [];

  return {
    async getEndpoint(id) {
      return endpoints.find(endpoint => endpoint.id === id) ?? null;
    },
    async listEnabledEndpoints() {
      return endpoints.filter(endpoint => endpoint.enabled);
    },
    async createDelivery(input) {
      const delivery: WebhookDelivery = {
        id: `delivery-${deliveries.length + 1}`,
        endpointId: input.endpointId,
        event: input.event,
        eventId: input.eventId,
        occurredAt: input.occurredAt,
        subscriber: {
          ownerType: input.subscriber.ownerType,
          ownerId: input.subscriber.ownerId,
          tenantId: input.subscriber.tenantId ?? null,
        },
        sourceScope: input.sourceScope ?? null,
        projectedPayload: input.payload,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      deliveries.push(delivery);
      return delivery;
    },
    async updateDelivery(id, input) {
      const delivery = deliveries.find(item => item.id === id);
      if (!delivery) {
        throw new Error('missing delivery');
      }
      Object.assign(delivery, input, { updatedAt: new Date().toISOString() });
      return delivery;
    },
    async getDelivery(id) {
      return deliveries.find(item => item.id === id) ?? null;
    },
    async listDeliveries() {
      return { items: [...deliveries], hasMore: false };
    },
  };
}

function createEndpoint(id = 'endpoint-1'): WebhookEndpoint {
  return {
    id,
    ownerType: 'tenant',
    ownerId: 'tenant-a',
    tenantId: 'tenant-a',
    url: 'https://example.com/hook',
    secret: 'secret-value',
    subscriptions: [
      {
        event: 'test:webhook.tenant.created',
        exposure: 'tenant-webhook',
      },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('eventWiring', () => {
  it('subscribes to matching registry events and delivers to authorized endpoints', async () => {
    const bus = createInProcessAdapter();
    const events = createEvents(bus);
    const adapter = createAdapter([createEndpoint()]);
    const queue = createWebhookMemoryQueue();
    const processorMock = mock(async () => {});
    await queue.start(processorMock);

    const config: WebhookPluginConfig = { events: ['test:webhook.tenant.*'] };
    const unsubs = wireEventSubscriptions(bus, events, config, queue, adapter);

    events.publish('test:webhook.tenant.created', {
      tenantId: 'tenant-a',
      documentId: 'doc-1',
    }, { requestTenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    const deliveries = await adapter.listDeliveries();
    expect(deliveries.items.length).toBe(1);
    expect(deliveries.items[0]).toMatchObject({
      event: 'test:webhook.tenant.created',
      subscriber: { ownerType: 'tenant', ownerId: 'tenant-a', tenantId: 'tenant-a' },
    });

    for (const unsub of unsubs) unsub();
    await queue.stop();
  });

  it('does not subscribe to non-matching registry event filters', async () => {
    const bus = createInProcessAdapter();
    const events = createEvents(bus);
    const adapter = createAdapter([createEndpoint()]);
    const queue = createWebhookMemoryQueue({ maxAttempts: 1 });
    await queue.start(async () => {});

    const config: WebhookPluginConfig = { events: ['security.*'] };
    const unsubs = wireEventSubscriptions(bus, events, config, queue, adapter);

    events.publish('test:webhook.tenant.created', {
      tenantId: 'tenant-a',
      documentId: 'doc-1',
    }, { requestTenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    const deliveries = await adapter.listDeliveries();
    expect(deliveries.items.length).toBe(0);

    for (const unsub of unsubs) unsub();
    await queue.stop();
  });

  it('subscribes to all webhook-visible definitions when config.events is omitted', async () => {
    const bus = createInProcessAdapter();
    const events = createEvents(bus);
    const adapter = createAdapter([createEndpoint()]);
    const queue = createWebhookMemoryQueue();
    await queue.start(async () => {});

    const config: WebhookPluginConfig = {};
    const unsubs = wireEventSubscriptions(bus, events, config, queue, adapter);

    events.publish('test:webhook.tenant.created', {
      tenantId: 'tenant-a',
      documentId: 'doc-1',
    }, { requestTenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    const deliveries = await adapter.listDeliveries();
    expect(deliveries.items.length).toBe(1);

    for (const unsub of unsubs) unsub();
    await queue.stop();
  });

  it('handles delivery resolution failure gracefully', async () => {
    const bus = createInProcessAdapter();
    const events = createEvents(bus);
    const queue = createWebhookMemoryQueue();
    await queue.start(async () => {});

    const failingAdapter: WebhookAdapter = {
      ...createAdapter(),
      async listEnabledEndpoints() {
        throw new Error('adapter exploded');
      },
    };

    const config: WebhookPluginConfig = { events: ['test:webhook.*'] };
    const unsubs = wireEventSubscriptions(bus, events, config, queue, failingAdapter);

    events.publish('test:webhook.tenant.created', {
      tenantId: 'tenant-a',
      documentId: 'doc-1',
    }, { requestTenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    for (const unsub of unsubs) unsub();
    await queue.stop();
  });

  it('compensates delivery to dead when enqueue fails', async () => {
    const bus = createInProcessAdapter();
    const events = createEvents(bus);
    const adapter = createAdapter([createEndpoint()]);

    const failingQueue = {
      name: 'failing',
      enqueue: mock(async () => {
        throw new Error('queue unavailable');
      }),
      start: mock(async () => {}),
      stop: mock(async () => {}),
      depth: mock(async () => 0),
    };

    const config: WebhookPluginConfig = { events: ['test:webhook.*'] };
    const unsubs = wireEventSubscriptions(bus, events, config, failingQueue, adapter);

    events.publish('test:webhook.tenant.created', {
      tenantId: 'tenant-a',
      documentId: 'doc-1',
    }, { requestTenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    const deliveries = await adapter.listDeliveries();
    expect(deliveries.items.length).toBe(1);
    expect(deliveries.items[0].status).toBe('dead');
    expect(deliveries.items[0].lastAttempt?.error).toContain('enqueue failed');

    for (const unsub of unsubs) unsub();
  });

  it('passes durable subscription options through to the bus and skips offEnvelope teardown', async () => {
    const events = createEventPublisher({
      definitions: createEventDefinitionRegistry(),
      bus: createInProcessAdapter(),
    });
    events.register(
      defineEvent('test:webhook.tenant.created', {
        ownerPlugin: 'test-webhooks',
        exposure: ['tenant-webhook'],
        resolveScope(payload) {
          return { tenantId: payload.tenantId };
        },
      }),
    );

    const onCalls: Array<{ event: string; opts?: SubscriptionOpts }> = [];
    const offEnvelopeMock = mock(() => {});
    const bus: SlingshotEventBus = {
      emit: () => {},
      on: (() => {}) as SlingshotEventBus['on'],
      off: (() => {}) as SlingshotEventBus['off'],
      onEnvelope: ((event: string, _listener: () => void, opts?: SubscriptionOpts) => {
        onCalls.push({ event, opts });
      }) as SlingshotEventBus['onEnvelope'],
      offEnvelope: offEnvelopeMock as SlingshotEventBus['offEnvelope'],
    };
    const adapter = createAdapter([createEndpoint()]);
    const queue = createWebhookMemoryQueue();
    const config: WebhookPluginConfig = {
      events: ['test:webhook.*'],
      busSubscription: {
        durable: true,
        name: 'webhooks',
      },
    };

    const unsubs = wireEventSubscriptions(bus, events, config, queue, adapter);

    expect(onCalls).toEqual([
      {
        event: 'test:webhook.tenant.created',
        opts: { durable: true, name: 'webhooks' },
      },
    ]);

    for (const unsub of unsubs) unsub();

    expect(offEnvelopeMock).not.toHaveBeenCalled();
  });
});
