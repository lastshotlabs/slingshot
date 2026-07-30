import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineEvent } from '@lastshotlabs/slingshot-core';
import { createCliEventReplayValidator } from '../../src/cli/lib/events/operations';

describe('event CLI replay validator', () => {
  test('fails closed when no shared contract callback is configured', () => {
    expect(createCliEventReplayValidator(undefined)).toBeUndefined();
  });

  test('uses shared definitions and adapters to validate stored replay', () => {
    const validator = createCliEventReplayValidator(events => {
      events.register(
        defineEvent('orders:order.created' as never, {
          schemaVersion: 2,
          ownerPlugin: 'orders',
          exposure: ['internal'],
          schema: z.object({ orderId: z.string(), currency: z.string() }) as never,
          resolveScope: () => null,
        }),
      );
      events.registerVersionAdapter({
        eventKey: 'orders:order.created',
        fromVersion: 1,
        toVersion: 2,
        adapt(payload) {
          return { ...(payload as object), currency: 'USD' };
        },
      });
    });
    const envelope = JSON.stringify({
      key: 'orders:order.created',
      payload: { orderId: 'order-1' },
      meta: {
        eventId: 'event-1',
        occurredAt: '2026-01-01T00:00:00Z',
        schemaVersion: 1,
        ownerPlugin: 'orders',
        exposure: ['internal'],
        scope: null,
        request: {
          requestId: null,
          correlationId: null,
          causationId: null,
          idempotencyKey: null,
          requestTenantId: null,
          actor: null,
          source: 'system',
        },
      },
    });
    expect(validator?.validate(envelope)).toMatchObject({
      compatible: true,
      storedVersion: 1,
      currentVersion: 2,
      adapted: true,
    });
  });
});
