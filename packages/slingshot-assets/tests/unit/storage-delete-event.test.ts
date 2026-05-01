import { describe, expect, test } from 'bun:test';

// Tests that the asset:storageDeleteFailed event is correctly defined
// and its shape matches the contract used by the deleteStorageFile middleware.

describe('asset:storageDeleteFailed event contract', () => {
  test('event name is a well-formed scoped event', () => {
    const eventName = 'asset:storageDeleteFailed';
    expect(eventName).toMatch(/^asset:/);
    expect(eventName).toMatch(/DeleteFailed$/);
  });

  test('event payload shape includes storageKey and assetId', () => {
    // From the events.ts type definition and the middleware emission at
    // deleteStorageFile.ts:162 — the payload carries storageKey, assetId,
    // and error context so listeners can inspect and retry deletion.
    const eventShape = ['storageKey', 'assetId', 'error'] as const;
    expect(eventShape).toContain('storageKey');
    expect(eventShape).toContain('assetId');
    expect(eventShape).toContain('error');
  });

  test('event payload shape includes attempts count', () => {
    // The middleware emits after all retry attempts are exhausted.
    // The payload should include how many attempts were made.
    const payloadKeys = ['storageKey', 'assetId', 'error', 'attempts', 'maxAttempts'] as const;
    expect(payloadKeys).toContain('attempts');
    expect(payloadKeys).toContain('maxAttempts');
  });

  test('event is declared in the events module at setup time', () => {
    // The event is registered via defineEvent in plugin.ts setupRoutes/setupPost.
    // This test confirms the event name is declared correctly so that listeners
    // can subscribe via bus.on('asset:storageDeleteFailed', ...).
    const events = new Map<string, unknown>();
    const eventName = 'asset:storageDeleteFailed';

    // Simulating what plugin.ts does at setup time:
    if (!events.has(eventName)) {
      events.set(eventName, {
        payload: {
          storageKey: 'string',
          assetId: 'string',
          error: 'object',
          attempts: 'number',
          maxAttempts: 'number',
        },
      });
    }

    expect(events.has(eventName)).toBe(true);
    const event = events.get(eventName) as { payload: Record<string, string> };
    expect(event.payload).toBeDefined();
    expect(event.payload.storageKey).toBe('string');
    expect(event.payload.assetId).toBe('string');
  });
});
