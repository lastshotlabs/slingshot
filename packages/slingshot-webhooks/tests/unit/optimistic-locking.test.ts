import { describe, expect, test } from 'bun:test';
import { createMemoryWebhookAdapter } from '../../src/adapters/memory.js';
import { WebhookDeliveryVersionConflict } from '../../src/types/models.js';

/**
 * P-WEBHOOKS-6: concurrent updates to the same delivery use optimistic
 * concurrency control. The losing writer sees a version conflict, refetches,
 * and retries; the winner's write is preserved.
 */
describe('memory adapter optimistic concurrency control (P-WEBHOOKS-6)', () => {
  test('two concurrent writes — second loses, refetches, applies on top', async () => {
    const adapter = createMemoryWebhookAdapter();
    adapter.addEndpoint({
      id: 'ep-1',
      ownerType: 'tenant',
      ownerId: 't1',
      tenantId: 't1',
      url: 'https://x.example/hook',
      secret: 's',
      subscriptions: [],
      enabled: true,
    });
    const delivery = await adapter.createDelivery({
      endpointId: 'ep-1',
      event: 'evt' as never,
      eventId: 'eid',
      occurredAt: new Date().toISOString(),
      subscriber: { ownerType: 'tenant', ownerId: 't1', tenantId: 't1' },
      sourceScope: null,
      payload: '{}',
      maxAttempts: 3,
    });
    expect(delivery.version).toBe(1);

    // Both writers read v1 and try to apply different updates.
    const writerA = adapter.updateDelivery(delivery.id, {
      attempts: 1,
      expectedVersion: 1,
    });
    const writerBPromise = (async () => {
      // Writer B started with v1 but A wins; B should observe a conflict.
      try {
        await adapter.updateDelivery(delivery.id, {
          attempts: 99,
          expectedVersion: 1,
        });
        return { status: 'committed' as const };
      } catch (err) {
        if (err instanceof WebhookDeliveryVersionConflict) {
          // Refetch and retry on top of the new version.
          const fresh = await adapter.getDelivery(delivery.id);
          if (!fresh) return { status: 'missing' as const };
          await adapter.updateDelivery(delivery.id, {
            attempts: fresh.attempts,
            lastAttempt: { attemptedAt: 'B', error: 'B-late' },
            expectedVersion: fresh.version,
          });
          return { status: 'retried' as const };
        }
        throw err;
      }
    })();

    await writerA;
    const result = await writerBPromise;
    expect(result.status).toBe('retried');

    const final = await adapter.getDelivery(delivery.id);
    expect(final).not.toBeNull();
    // Both writers' contributions land: A's attempts=1 (A wrote first), then
    // B refetched and applied lastAttempt on top.
    expect(final!.attempts).toBe(1);
    expect(final!.lastAttempt?.error).toBe('B-late');
    expect(final!.version).toBe(3);
  });

  test('update without expectedVersion still bumps version (unconditional path)', async () => {
    const adapter = createMemoryWebhookAdapter();
    adapter.addEndpoint({
      id: 'ep-2',
      ownerType: 'tenant',
      ownerId: 't1',
      tenantId: 't1',
      url: 'https://x.example/hook',
      secret: 's',
      subscriptions: [],
      enabled: true,
    });
    const d = await adapter.createDelivery({
      endpointId: 'ep-2',
      event: 'evt' as never,
      eventId: 'eid',
      occurredAt: new Date().toISOString(),
      subscriber: { ownerType: 'tenant', ownerId: 't1', tenantId: 't1' },
      sourceScope: null,
      payload: '{}',
      maxAttempts: 3,
    });
    const u = await adapter.updateDelivery(d.id, { attempts: 1 });
    expect(u.version).toBe(2);
  });
});
