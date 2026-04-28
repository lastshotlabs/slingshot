import { describe, expect, test } from 'bun:test';
import {
  pushDeliveryFactories,
  pushSubscriptionFactories,
  pushTopicFactories,
  pushTopicMembershipFactories,
} from '../../src/entities/factories';

describe('push entity factories', () => {
  test('exports store factories for each push entity', () => {
    const factorySets = [
      pushSubscriptionFactories,
      pushTopicFactories,
      pushTopicMembershipFactories,
      pushDeliveryFactories,
    ];

    for (const factories of factorySets) {
      expect(typeof factories.memory).toBe('function');
      expect(typeof factories.redis).toBe('function');
      expect(typeof factories.sqlite).toBe('function');
      expect(typeof factories.mongo).toBe('function');
      expect(typeof factories.postgres).toBe('function');
    }
  });

  test('wires generated push operations onto memory adapters', () => {
    const subscriptions = pushSubscriptionFactories.memory();
    const topics = pushTopicFactories.memory();
    const memberships = pushTopicMembershipFactories.memory();
    const deliveries = pushDeliveryFactories.memory();

    expect(typeof subscriptions.upsertByDevice).toBe('function');
    expect(typeof subscriptions.findByDevice).toBe('function');
    expect(typeof topics.findByName).toBe('function');
    expect(typeof memberships.ensureMembership).toBe('function');
    expect(typeof deliveries.markSent).toBe('function');
  });
});
