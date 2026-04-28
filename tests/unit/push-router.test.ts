import { describe, expect, it } from 'bun:test';
import { createPushDeliveryAdapter } from '../../packages/slingshot-push/src/deliveryAdapter';
import { compilePushFormatters } from '../../packages/slingshot-push/src/formatter';
import { createPushRouter } from '../../packages/slingshot-push/src/router';
import type {
  PushDeliveryRecord,
  PushMessage,
  PushSubscriptionRecord,
} from '../../packages/slingshot-push/src/types/models';

function createSubscription(
  overrides: Partial<PushSubscriptionRecord> = {},
): PushSubscriptionRecord {
  return {
    id: 'sub-1',
    userId: 'user-1',
    tenantId: '',
    deviceId: 'device-1',
    platform: 'web',
    platformData: {
      platform: 'web',
      endpoint: 'https://push.example.com/sub-1',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    },
    createdAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  };
}

function createDelivery(overrides: Partial<PushDeliveryRecord> = {}): PushDeliveryRecord {
  return {
    id: 'delivery-1',
    tenantId: '',
    userId: 'user-1',
    subscriptionId: 'sub-1',
    platform: 'web',
    status: 'pending',
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('createPushRouter', () => {
  it('cleans up invalid subscriptions and emits failure events', async () => {
    const deletedSubscriptionIds: string[] = [];
    const removedMembershipIds: string[] = [];
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const delivery = createDelivery();
    const subscription = createSubscription();

    const router = createPushRouter({
      providers: {
        web: {
          platform: 'web',
          async send() {
            return { ok: false, reason: 'invalidToken', error: 'expired endpoint' };
          },
        },
      },
      repos: {
        subscriptions: {
          async create() {
            return subscription;
          },
          async getById() {
            return subscription;
          },
          async delete(id) {
            deletedSubscriptionIds.push(id);
            return true;
          },
          async listByUserId() {
            return [subscription];
          },
          async findByDevice() {
            return subscription;
          },
          async touchLastSeen() {
            return subscription;
          },
          async upsertByDevice() {
            return subscription;
          },
        },
        topics: {
          async ensureByName() {
            return { id: 'topic-1', tenantId: '', name: 'deploys' };
          },
          async findByName() {
            return null;
          },
        },
        topicMemberships: {
          async ensureMembership() {
            return {
              id: 'membership-1',
              topicId: 'topic-1',
              subscriptionId: subscription.id,
              userId: subscription.userId,
              tenantId: '',
              createdAt: new Date(),
            };
          },
          async listByTopic() {
            return [];
          },
          async removeByTopicAndSub() {
            return 0;
          },
          async removeBySubscription({ subscriptionId }) {
            removedMembershipIds.push(subscriptionId);
            return 1;
          },
        },
        deliveries: {
          async create() {
            return delivery;
          },
          async getById() {
            return delivery;
          },
          async markSent() {
            return createDelivery({ status: 'sent' });
          },
          async markDelivered() {
            return createDelivery({ status: 'delivered' });
          },
          async markFailed() {
            return createDelivery({ status: 'failed', failureReason: 'invalidToken' });
          },
          async incrementAttempts() {
            return createDelivery({ attempts: 1 }) as unknown as Record<string, unknown>;
          },
        },
      },
      bus: {
        emit(event, payload) {
          emitted.push({ event, payload });
        },
      },
    });

    const result = await router.sendToUser('user-1', { title: 'Deploy ready' });

    expect(result.delivered).toBe(0);
    expect(result.allFailed).toBe(true);
    expect(deletedSubscriptionIds).toEqual(['sub-1']);
    expect(removedMembershipIds).toEqual(['sub-1']);
    expect(emitted.map(entry => entry.event)).toEqual([
      'push:delivery.failed',
      'push:subscription.invalidated',
    ]);
    expect(emitted[1]?.payload).toMatchObject({
      subscriptionId: 'sub-1',
      userId: 'user-1',
      platform: 'web',
      reason: 'expired endpoint',
    });
  });

  it('emits sent events for successful deliveries', async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const subscription = createSubscription();

    const router = createPushRouter({
      providers: {
        web: {
          platform: 'web',
          async send() {
            return { ok: true, providerMessageId: 'provider-1' };
          },
        },
      },
      repos: {
        subscriptions: {
          async create() {
            return subscription;
          },
          async getById() {
            return subscription;
          },
          async delete() {
            return true;
          },
          async listByUserId() {
            return [subscription];
          },
          async findByDevice() {
            return subscription;
          },
          async touchLastSeen() {
            return subscription;
          },
          async upsertByDevice() {
            return subscription;
          },
        },
        topics: {
          async ensureByName() {
            return { id: 'topic-1', tenantId: '', name: 'deploys' };
          },
          async findByName() {
            return null;
          },
        },
        topicMemberships: {
          async ensureMembership() {
            throw new Error('not used');
          },
          async listByTopic() {
            return [];
          },
          async removeByTopicAndSub() {
            return 0;
          },
          async removeBySubscription() {
            return 0;
          },
        },
        deliveries: {
          async create() {
            return createDelivery();
          },
          async getById() {
            return createDelivery();
          },
          async markSent() {
            return createDelivery({ status: 'sent', providerMessageId: 'provider-1' });
          },
          async markDelivered() {
            return createDelivery({ status: 'delivered' });
          },
          async markFailed() {
            return createDelivery({ status: 'failed', failureReason: 'transient' });
          },
          async incrementAttempts() {
            return createDelivery({ attempts: 1 }) as unknown as Record<string, unknown>;
          },
        },
      },
      bus: {
        emit(event, payload) {
          emitted.push({ event, payload });
        },
      },
    });

    const result = await router.sendToUser('user-1', { title: 'Deploy ready' });

    expect(result.delivered).toBe(1);
    expect(result.allFailed).toBe(false);
    expect(emitted).toEqual([
      {
        event: 'push:delivery.sent',
        payload: {
          deliveryId: 'delivery-1',
          subscriptionId: 'sub-1',
          userId: 'user-1',
          providerMessageId: 'provider-1',
          providerIdempotencyKey: 'delivery-1:1',
        },
      },
    ]);
  });
});

describe('createPushDeliveryAdapter', () => {
  it('applies formatter defaults when the notification has no explicit target URL', async () => {
    const captured: Array<{ userId: string; message: PushMessage; notificationId?: string }> = [];
    const adapter = createPushDeliveryAdapter({
      router: {
        async sendToUser(userId, message, opts) {
          captured.push({ userId, message, notificationId: opts?.notificationId });
          return { delivered: 1, attempted: 1, allFailed: false };
        },
        async sendToUsers() {
          return { delivered: 0, attempted: 0, allFailed: false };
        },
        async publishTopic() {
          return { delivered: 0, attempted: 0, allFailed: false };
        },
      },
      formatters: compilePushFormatters({
        'community:reply': {
          titleTemplate: 'Reply from ${notification.data.authorName}',
          bodyTemplate: '${notification.data.bodyPreview}',
        },
      }),
      defaults: {
        icon: '/icon.png',
        badge: '/badge.png',
        defaultUrl: '/inbox',
      },
    });

    await adapter.deliver({
      notification: {
        id: 'notification-1',
        userId: 'user-1',
        tenantId: '',
        source: 'community',
        type: 'community:reply',
        targetId: null,
        actorId: 'user-2',
        data: {
          authorName: 'Alicia',
          bodyPreview: 'Latest reply body',
        },
        read: false,
        dispatched: false,
        priority: 'normal',
        createdAt: new Date(),
      },
      preferences: {
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        muted: false,
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      userId: 'user-1',
      message: {
        title: 'Reply from Alicia',
        body: 'Latest reply body',
        icon: '/icon.png',
        badge: '/badge.png',
        url: '/inbox',
        data: {},
      },
      notificationId: 'notification-1',
    });
  });
});
