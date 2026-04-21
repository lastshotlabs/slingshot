/**
 * Tests for F10 — breached password API failure event emission.
 *
 * Before F10, `checkBreachedPassword` only emitted `security.breached_password.api_failure`
 * when `onApiFailure === 'block'`. After F10, the event is emitted regardless of policy —
 * `allow` (fail-open) and `block` (fail-closed) both emit it. This ensures the failure
 * is always observable in security event streams.
 *
 * Covers:
 *   - Event emitted when HIBP API returns an HTTP error (regardless of onApiFailure)
 *   - Event emitted when HIBP API connection times out
 *   - `onApiFailure: 'allow'` → breached=false (fail-open) but event still emitted
 *   - `onApiFailure: 'block'` → breached=true (fail-closed) and event emitted
 *   - No event emitted when API succeeds and password is clean
 *   - No event emitted when API succeeds and password is breached (different event)
 */
import { describe, expect, test } from 'bun:test';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { checkBreachedPassword } from '../../src/lib/breachedPassword';

// Build a minimal event bus that records emitted event names
function makeCapturingBus(): { bus: SlingshotEventBus; events: string[] } {
  const events: string[] = [];
  const bus: SlingshotEventBus = {
    emit: (event: string) => events.push(event),
    on: () => {},
    off: () => {},
    shutdown: async () => {},
  } as unknown as SlingshotEventBus;
  return { bus, events };
}

// Return a global fetch mock that will be restored after each test
function mockFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('checkBreachedPassword — API failure event emission (F10)', () => {
  test('emits api_failure event when HIBP API returns a non-OK status (onApiFailure: allow)', async () => {
    const restore = mockFetch(async () => new Response('Error', { status: 503 }));
    const { bus, events } = makeCapturingBus();

    try {
      const result = await checkBreachedPassword('anypassword', { onApiFailure: 'allow' }, {}, bus);
      expect(result.breached).toBe(false); // fail-open
    } finally {
      restore();
    }

    expect(events).toContain('security.breached_password.api_failure');
  });

  test('emits api_failure event when HIBP API returns a non-OK status (onApiFailure: block)', async () => {
    const restore = mockFetch(async () => new Response('Error', { status: 503 }));
    const { bus, events } = makeCapturingBus();

    try {
      const result = await checkBreachedPassword('anypassword', { onApiFailure: 'block' }, {}, bus);
      expect(result.breached).toBe(true); // fail-closed
      expect(result.count).toBe(-1);
    } finally {
      restore();
    }

    expect(events).toContain('security.breached_password.api_failure');
  });

  test('emits api_failure event when fetch throws (connection error)', async () => {
    const restore = mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { bus, events } = makeCapturingBus();

    try {
      await checkBreachedPassword('anypassword', {}, {}, bus);
    } finally {
      restore();
    }

    expect(events).toContain('security.breached_password.api_failure');
  });

  test('does NOT emit api_failure when HIBP API succeeds and password is clean', async () => {
    // Simulate HIBP returning a list that does NOT contain our hash suffix
    const restore = mockFetch(
      async () => new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\r\n', { status: 200 }),
    );
    const { bus, events } = makeCapturingBus();

    try {
      await checkBreachedPassword('cleanpassword123', {}, {}, bus);
    } finally {
      restore();
    }

    expect(events).not.toContain('security.breached_password.api_failure');
  });

  test('does NOT emit api_failure (emits detected instead) when password is in breach list', async () => {
    // We need a password whose SHA-1 suffix matches what we return from the mock.
    // Use an empty string: SHA-1('') = DA39A3EE5E6B4B0D3255BFEF95601890AFD80709
    // prefix = DA39A, suffix = 3EE5E6B4B0D3255BFEF95601890AFD80709
    const restore = mockFetch(
      async () => new Response('3EE5E6B4B0D3255BFEF95601890AFD80709:42\r\n', { status: 200 }),
    );
    const { bus, events } = makeCapturingBus();

    try {
      const result = await checkBreachedPassword('', {}, {}, bus);
      expect(result.breached).toBe(true);
      expect(result.count).toBe(42);
    } finally {
      restore();
    }

    expect(events).toContain('security.breached_password.detected');
    expect(events).not.toContain('security.breached_password.api_failure');
  });

  test('api_failure event carries userId and ip from context when provided', async () => {
    const restore = mockFetch(async () => new Response('Error', { status: 500 }));
    const emittedPayloads: Array<{ event: string; data: unknown }> = [];
    const bus: SlingshotEventBus = {
      emit: (event: string, data: unknown) => emittedPayloads.push({ event, data }),
      on: () => {},
      off: () => {},
      shutdown: async () => {},
    } as unknown as SlingshotEventBus;

    try {
      await checkBreachedPassword('anypassword', {}, { userId: 'user-123', ip: '1.2.3.4' }, bus);
    } finally {
      restore();
    }

    const failEvent = emittedPayloads.find(
      e => e.event === 'security.breached_password.api_failure',
    );
    expect(failEvent).toBeDefined();
    const failMeta = (failEvent!.data as { meta?: Record<string, unknown> }).meta;
    expect(failMeta?.['userId']).toBe('user-123');
    expect(failMeta?.['ip']).toBe('1.2.3.4');
  });
});
