import { describe, expect, test } from 'bun:test';
import type { AcknowledgedEventBus, EventEnvelope } from '@lastshotlabs/slingshot-core';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type {
  EventReliabilityOperations,
  OutboxOperationalStatus,
} from '@lastshotlabs/slingshot-events';
import { createMetricsState, serializeMetrics } from '../../src/framework/metrics/registry';
import {
  createEventReliabilityIndicators,
  registerEventReliabilityMetrics,
} from '../../src/framework/persistence/events/reliabilityOperations';

function operations(status: OutboxOperationalStatus): EventReliabilityOperations {
  return {
    async status() {
      return status;
    },
    async list() {
      return [];
    },
    async inspect() {
      return null;
    },
    async validateReplay() {
      return {
        compatible: false,
        eventKey: '',
        storedVersion: 1,
        currentVersion: null,
        reason: 'validator-unavailable',
      };
    },
    async listReplayAudit() {
      return [];
    },
    async retryEvent() {
      return false;
    },
    async retryAllDead() {
      return 0;
    },
    async purgeDelivered() {
      return 0;
    },
    async purgeInbox() {
      return 0;
    },
  };
}

function bus(healthy: boolean): AcknowledgedEventBus {
  return Object.assign(createInProcessAdapter(), {
    async publishEnvelope(envelope: EventEnvelope) {
      return {
        eventId: envelope.meta.eventId,
        acceptedAt: new Date().toISOString(),
        transport: 'kafka' as const,
        durableDestinations: 1,
      };
    },
    health() {
      return { connected: healthy };
    },
  });
}

const healthyStatus: OutboxOperationalStatus = {
  counts: { pending: 0, leased: 0, delivered: 3, dead: 0 },
  oldestPendingAt: null,
  expiredLeases: 0,
};

describe('event reliability readiness and metrics', () => {
  test('uses cached transport state and remains responsive during broker outage', async () => {
    const indicators = createEventReliabilityIndicators(operations(healthyStatus), bus(false), {
      store: 'postgres',
      outbox: { enabled: true },
    });
    const started = performance.now();
    const critical = await indicators[0]?.check({ ctx: {} as never });
    expect(performance.now() - started).toBeLessThan(50);
    expect(critical?.status).toBe('unhealthy');
    expect(critical?.details).toEqual({ dead: 0, transportHealthy: false });
  });

  test('applies configured dead-row warning versus critical policy', async () => {
    const dead = operations({
      ...healthyStatus,
      counts: { ...healthyStatus.counts, dead: 2 },
    });
    const warning = createEventReliabilityIndicators(dead, bus(true), {
      store: 'sqlite',
      outbox: { enabled: true },
      readiness: { deadRows: 'warning' },
    });
    const critical = createEventReliabilityIndicators(dead, bus(true), {
      store: 'sqlite',
      outbox: { enabled: true },
      readiness: { deadRows: 'critical' },
    });

    expect((await warning[0]?.check({ ctx: {} as never }))?.status).toBe('healthy');
    expect((await warning[1]?.check({ ctx: {} as never }))?.status).toBe('degraded');
    expect((await critical[0]?.check({ ctx: {} as never }))?.status).toBe('unhealthy');
  });

  test('metrics expose only bounded store, transport, and status dimensions', async () => {
    const state = createMetricsState();
    const observe = registerEventReliabilityMetrics(state, operations(healthyStatus), 'postgres');
    observe.outbox({
      action: 'acknowledged',
      eventKey: 'orders:order.created',
      eventIdShort: 'secret-id',
      transport: 'kafka',
      durationMs: 12,
    });
    observe.inbox({ action: 'duplicate' });
    const output = await serializeMetrics(state);

    expect(output).toContain(
      'slingshot_event_outbox_acknowledged_total{store="postgres",transport="kafka"} 1',
    );
    expect(output).toContain('slingshot_event_inbox_duplicate_total{store="postgres"} 1');
    expect(output).toContain('slingshot_event_outbox_rows{status="delivered",store="postgres"} 3');
    expect(output).not.toContain('orders:order.created');
    expect(output).not.toContain('secret-id');
  });
});
