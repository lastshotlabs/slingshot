import { describe, expect, it, mock } from 'bun:test';
import type { SlingshotEventBus, SubscriptionOpts } from '@lastshotlabs/slingshot-core';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { wireEventSubscriptions } from '../../src/lib/eventWiring';
import { createWebhookMemoryQueue } from '../../src/queues/memory';
import type { WebhookAdapter } from '../../src/types/adapter';
import type { WebhookPluginConfig } from '../../src/types/config';
import type { WebhookDelivery, WebhookEndpoint } from '../../src/types/models';

function createAdapter(seedEndpoints: WebhookEndpoint[] = []): WebhookAdapter {
  const endpoints = [...seedEndpoints];
  const deliveries: WebhookDelivery[] = [];

  return {
    async getEndpoint(id) {
      return endpoints.find(endpoint => endpoint.id === id) ?? null;
    },
    async findEndpointsForEvent() {
      return endpoints;
    },
    async createDelivery(input) {
      const delivery: WebhookDelivery = {
        id: `delivery-${deliveries.length + 1}`,
        endpointId: input.endpointId,
        event: input.event,
        payload: input.payload,
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
    url: 'https://example.com/hook',
    secret: 'secret-value',
    events: ['auth:*'],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('eventWiring', () => {
  it('subscribes to matching events and delivers to matching endpoints', async () => {
    const bus = createInProcessAdapter();
    const adapter = createAdapter([createEndpoint()]);
    const queue = createWebhookMemoryQueue();
    const processorMock = mock(async () => {});
    await queue.start(processorMock);

    const config: WebhookPluginConfig = { events: ['auth:*'] };
    const unsubs = wireEventSubscriptions(bus, config, queue, adapter);

    bus.emit('auth:user.created', { userId: 'u1', email: 'u@example.com', tenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    const deliveries = await adapter.listDeliveries();
    expect(deliveries.items.length).toBe(1);
    expect(deliveries.items[0].event).toBe('auth:user.created');

    for (const unsub of unsubs) unsub();
    await queue.stop();
  });

  it('does not subscribe to non-matching events', async () => {
    const bus = createInProcessAdapter();
    const adapter = createAdapter([createEndpoint()]);
    const queue = createWebhookMemoryQueue({ maxAttempts: 1 });
    await queue.start(async () => {});

    const config: WebhookPluginConfig = { events: ['security.*'] };
    const unsubs = wireEventSubscriptions(bus, config, queue, adapter);

    bus.emit('auth:user.created', { userId: 'u1', email: 'u@example.com', tenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    const deliveries = await adapter.listDeliveries();
    expect(deliveries.items.length).toBe(0);

    for (const unsub of unsubs) unsub();
    await queue.stop();
  });

  it('subscribes to all events when config.events is omitted', async () => {
    const bus = createInProcessAdapter();
    const adapter = createAdapter([createEndpoint()]);
    const queue = createWebhookMemoryQueue();
    await queue.start(async () => {});

    const config: WebhookPluginConfig = {};
    const unsubs = wireEventSubscriptions(bus, config, queue, adapter);

    bus.emit('auth:user.created', { userId: 'u1', email: 'u@example.com', tenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    const deliveries = await adapter.listDeliveries();
    expect(deliveries.items.length).toBe(1);

    for (const unsub of unsubs) unsub();
    await queue.stop();
  });

  it('handles findEndpointsForEvent failure gracefully', async () => {
    const bus = createInProcessAdapter();
    const queue = createWebhookMemoryQueue();
    await queue.start(async () => {});

    const failingAdapter: WebhookAdapter = {
      ...createAdapter(),
      async findEndpointsForEvent() {
        throw new Error('adapter exploded');
      },
    };

    const config: WebhookPluginConfig = { events: ['auth:*'] };
    const unsubs = wireEventSubscriptions(bus, config, queue, failingAdapter);

    bus.emit('auth:user.created', { userId: 'u1', email: 'u@example.com', tenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    for (const unsub of unsubs) unsub();
    await queue.stop();
  });

  it('compensates delivery to dead when enqueue fails', async () => {
    const bus = createInProcessAdapter();
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

    const config: WebhookPluginConfig = { events: ['auth:*'] };
    const unsubs = wireEventSubscriptions(bus, config, failingQueue, adapter);

    bus.emit('auth:user.created', { userId: 'u1', email: 'u@example.com', tenantId: null });
    await new Promise(resolve => setTimeout(resolve, 30));

    const deliveries = await adapter.listDeliveries();
    expect(deliveries.items.length).toBe(1);
    expect(deliveries.items[0].status).toBe('dead');
    expect(deliveries.items[0].lastAttempt?.error).toContain('enqueue failed');

    for (const unsub of unsubs) unsub();
  });

  it('passes durable subscription options through to the bus and skips off() teardown', async () => {
    const onCalls: Array<{ event: string; opts?: SubscriptionOpts }> = [];
    const offMock = mock(() => {});
    const bus: SlingshotEventBus = {
      emit: () => {},
      on: ((
        event: string,
        _listener: (payload: unknown) => void | Promise<void>,
        opts?: SubscriptionOpts,
      ) => {
        onCalls.push({ event, opts });
      }) as SlingshotEventBus['on'],
      off: offMock as SlingshotEventBus['off'],
      clientSafeKeys: new Set<string>(),
      registerClientSafeEvents: () => {},
      ensureClientSafeEventKey: key => key,
    };
    const adapter = createAdapter([createEndpoint()]);
    const queue = createWebhookMemoryQueue();
    const config: WebhookPluginConfig = {
      events: ['auth:*'],
      busSubscription: {
        durable: true,
        name: 'webhooks',
      },
    };

    const unsubs = wireEventSubscriptions(bus, config, queue, adapter);

    expect(onCalls.length).toBeGreaterThan(0);
    expect(onCalls[0]?.event).toBe('auth:user.created');
    expect(onCalls[0]?.opts).toEqual({ durable: true, name: 'webhooks' });

    for (const unsub of unsubs) unsub();

    expect(offMock).not.toHaveBeenCalled();
  });
});
