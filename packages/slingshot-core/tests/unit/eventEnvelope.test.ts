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
});
