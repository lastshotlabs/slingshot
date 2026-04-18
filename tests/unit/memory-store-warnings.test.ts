/**
 * Tests that memory adapters log a one-time "no eviction" warning on first use.
 * These warnings are intentional — memory adapters are for development/testing only.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

describe('Memory adapters emit dev-only warnings', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn');
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('createWebhookMemoryQueue warns about memory-only usage', async () => {
    const { createWebhookMemoryQueue } = await import('@lastshotlabs/slingshot-webhooks');
    createWebhookMemoryQueue();

    const calls = warnSpy.mock.calls.flat();
    const hasWarning = calls.some(
      (msg: unknown) => typeof msg === 'string' && msg.includes('no eviction'),
    );
    expect(hasWarning).toBe(true);
  });

  test('createAuditLogProvider with memory store warns about memory-only usage', async () => {
    const { createAuditLogProvider } = await import('../../src/framework/auditLog');
    createAuditLogProvider({ store: 'memory' });

    const calls = warnSpy.mock.calls.flat();
    const hasWarning = calls.some(
      (msg: unknown) => typeof msg === 'string' && msg.includes('no eviction'),
    );
    expect(hasWarning).toBe(true);
  });
});
