import { describe, expect, test } from 'bun:test';
import {
  createEventEnvelope,
  createRawEventEnvelope,
  isEventEnvelope,
} from '../../src/eventEnvelope';

describe('eventEnvelope', () => {
  test('creates an immutable envelope snapshot', () => {
    const envelope = createEventEnvelope({
      key: 'app:ready',
      payload: { plugins: ['alpha'] },
      ownerPlugin: 'slingshot-framework',
      exposure: ['internal'],
      scope: null,
      source: 'system',
      requestTenantId: null,
    });

    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.payload)).toBe(true);
    expect(Object.isFrozen(envelope.meta)).toBe(true);
    expect(Object.isFrozen(envelope.meta.exposure)).toBe(true);
    expect(() => ((envelope.payload as { plugins: string[] }).plugins = [])).toThrow();
  });

  test('creates raw envelopes for legacy bus emits', () => {
    const envelope = createRawEventEnvelope('app:shutdown', { signal: 'SIGTERM' });

    expect(envelope.meta.ownerPlugin).toBe('slingshot-raw-bus');
    expect(envelope.meta.exposure).toEqual(['internal']);
    expect(envelope.meta.scope).toBeNull();
  });

  test('detects event envelopes', () => {
    const envelope = createRawEventEnvelope('app:ready', { plugins: [] });

    expect(isEventEnvelope(envelope)).toBe(true);
    expect(isEventEnvelope(envelope, 'app:ready')).toBe(true);
    expect(isEventEnvelope(envelope, 'app:shutdown')).toBe(false);
    expect(isEventEnvelope({ key: 'app:ready' })).toBe(false);
  });

  test('raw envelopes have undefined requestId and correlationId', () => {
    const envelope = createRawEventEnvelope('app:ready', { plugins: [] });

    expect(envelope.meta.requestId).toBeUndefined();
    expect(envelope.meta.correlationId).toBeUndefined();
    expect(envelope.meta.source).toBe('system');
    expect(envelope.meta.requestTenantId).toBeNull();
  });

  test('propagates explicit requestId and correlationId', () => {
    const envelope = createEventEnvelope({
      key: 'app:ready',
      payload: { plugins: [] },
      ownerPlugin: 'slingshot-framework',
      exposure: ['internal'],
      scope: null,
      source: 'http',
      requestId: 'req-123',
      correlationId: 'corr-456',
      requestTenantId: 'tenant-1',
    });

    expect(envelope.meta.requestId).toBe('req-123');
    expect(envelope.meta.correlationId).toBe('corr-456');
    expect(envelope.meta.requestTenantId).toBe('tenant-1');
  });

  test('isEventEnvelope returns false for primitives', () => {
    expect(isEventEnvelope(null)).toBe(false);
    expect(isEventEnvelope(undefined)).toBe(false);
    expect(isEventEnvelope(42)).toBe(false);
    expect(isEventEnvelope('string')).toBe(false);
    expect(isEventEnvelope(true)).toBe(false);
  });

  test('isEventEnvelope returns false for objects with wrong meta shape', () => {
    expect(isEventEnvelope({ key: 'test', meta: null })).toBe(false);
    expect(isEventEnvelope({ key: 'test', meta: { eventId: 123 } })).toBe(false);
    expect(
      isEventEnvelope({
        key: 'test',
        meta: { eventId: 'ok', occurredAt: 'ok', ownerPlugin: 'ok', exposure: 'not-array' },
      }),
    ).toBe(false);
  });

  test('isEventEnvelope rejects objects missing key', () => {
    expect(isEventEnvelope({ meta: { eventId: 'a', occurredAt: 'b', ownerPlugin: 'c', exposure: [] } })).toBe(false);
    expect(isEventEnvelope({ key: 123, meta: { eventId: 'a', occurredAt: 'b', ownerPlugin: 'c', exposure: [] } })).toBe(false);
  });

  test('envelope payload nested objects are frozen', () => {
    const envelope = createEventEnvelope({
      key: 'app:ready',
      payload: { plugins: ['alpha'], nested: { deep: true } },
      ownerPlugin: 'slingshot-framework',
      exposure: ['internal'],
      scope: null,
      source: 'system',
      requestTenantId: null,
    });

    const payload = envelope.payload as { plugins: string[]; nested: { deep: boolean } };
    expect(Object.isFrozen(payload.nested)).toBe(true);
  });
});
