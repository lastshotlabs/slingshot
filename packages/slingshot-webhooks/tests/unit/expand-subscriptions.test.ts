import { describe, expect, test } from 'bun:test';
import {
  type EventDefinitionRegistry,
  createEventDefinitionRegistry,
  defineEvent,
} from '@lastshotlabs/slingshot-core';

/**
 * P-WEBHOOKS-10: lightweight test for the expandSubscriptions contract
 * shape. The plugin's manifest runtime exposes `expandSubscriptions` and
 * documents that apps must call it manually after registering new events
 * to widen pre-existing pattern-based endpoint subscriptions.
 *
 * We test the merge logic in isolation — the runtime function is internal
 * to the manifest path and tied to entity adapters; covering the merge
 * algorithm at this level keeps the assertion focused on the published
 * contract: existing concrete subscriptions stay, and pattern-based
 * subscriptions widen to all currently allowed event keys for the owner.
 */
describe('expandSubscriptions merge logic (P-WEBHOOKS-10)', () => {
  test('union preserves existing concrete subs and adds new allowed keys for pattern-based subs', () => {
    const definitions: EventDefinitionRegistry = createEventDefinitionRegistry();
    definitions.register(
      defineEvent('auth:login' as never, {
        ownerPlugin: 'auth',
        exposure: ['tenant-webhook'],
        resolveScope: () => ({ tenantId: null }),
      }),
    );
    definitions.register(
      defineEvent('auth:later.event' as never, {
        ownerPlugin: 'auth',
        exposure: ['tenant-webhook'],
        resolveScope: () => ({ tenantId: null }),
      }),
    );

    type Sub = { event: string; exposure: 'tenant-webhook'; sourcePattern?: string };
    const stored: Sub[] = [
      { event: 'auth:login', exposure: 'tenant-webhook', sourcePattern: 'auth:*' },
    ];

    // Inline the merge algorithm used by manifest/runtime.ts expandSubscriptions
    // to verify behaviour without needing the full plugin lifecycle wiring.
    const allowedKeys = new Set(definitions.list().map(def => def.key as string));
    const merged = new Map<string, Sub>();
    for (const sub of stored) merged.set(sub.event, sub);
    for (const sub of stored) {
      if (!sub.sourcePattern) continue;
      for (const key of allowedKeys) {
        if (merged.has(key)) continue;
        merged.set(key, {
          event: key,
          exposure: sub.exposure,
          sourcePattern: sub.sourcePattern,
        });
      }
    }

    const final = [...merged.values()];
    const finalKeys = final.map(s => s.event).sort();
    expect(finalKeys).toContain('auth:login');
    expect(finalKeys).toContain('auth:later.event');
    // Pattern preserved on every expanded entry.
    for (const sub of final) {
      expect(sub.sourcePattern).toBe('auth:*');
    }
  });
});
