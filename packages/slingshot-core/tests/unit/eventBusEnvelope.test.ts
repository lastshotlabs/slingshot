import { describe, expect, test } from 'bun:test';
import { createEventEnvelope, createInProcessAdapter } from '../../src';

describe('eventBus envelope listeners', () => {
  test('delivers payload listeners and envelope listeners from the same emit', () => {
    const bus = createInProcessAdapter();
    const payloads: Array<{ userId: string; sessionId: string }> = [];
    const owners: string[] = [];

    bus.on('auth:login', payload => {
      payloads.push(payload);
    });
    bus.onEnvelope('auth:login', envelope => {
      owners.push(envelope.meta.ownerPlugin);
    });

    bus.emit(
      'auth:login',
      createEventEnvelope({
        key: 'auth:login',
        payload: { userId: 'user-1', sessionId: 'session-1' },
        ownerPlugin: 'slingshot-auth',
        exposure: ['user-webhook'],
        scope: { userId: 'user-1' },
      }),
    );

    expect(payloads).toEqual([{ userId: 'user-1', sessionId: 'session-1' }]);
    expect(owners).toEqual(['slingshot-auth']);
  });
});
