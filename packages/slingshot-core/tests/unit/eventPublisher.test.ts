import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  authorizeEventSubscriber,
  createEventDefinitionRegistry,
  createEventPublisher,
  createInProcessAdapter,
  defineEvent,
} from '../../src';

describe('eventPublisher', () => {
  test('throws when publishing an unregistered event', () => {
    const publisher = createEventPublisher({
      definitions: createEventDefinitionRegistry(),
      bus: createInProcessAdapter(),
    });

    expect(() =>
      publisher.publish('app:ready', { plugins: [] }, { requestTenantId: null }),
    ).toThrow('not registered');
  });

  test('publishes validated envelopes through the bus', () => {
    const bus = createInProcessAdapter();
    const envelopes: unknown[] = [];
    const payloads: unknown[] = [];
    const registry = createEventDefinitionRegistry();
    registry.register(
      defineEvent('auth:login', {
        ownerPlugin: 'slingshot-auth',
        exposure: ['user-webhook'],
        schema: z.object({
          userId: z.string(),
          sessionId: z.string(),
          tenantId: z.string().optional(),
        }),
        resolveScope(payload, ctx) {
          return {
            tenantId: payload.tenantId ?? ctx.requestTenantId ?? null,
            userId: payload.userId,
            actorId: ctx.actorId ?? payload.userId,
          };
        },
      }),
    );
    const publisher = createEventPublisher({ definitions: registry, bus });

    bus.on('auth:login', payload => {
      payloads.push(payload);
    });
    bus.onEnvelope('auth:login', envelope => {
      envelopes.push(envelope);
    });

    const envelope = publisher.publish(
      'auth:login',
      { userId: 'user-1', sessionId: 'session-1', tenantId: 'tenant-1' },
      { actorId: 'user-1', source: 'http', requestTenantId: 'tenant-1' },
    );

    expect(payloads).toHaveLength(1);
    expect(envelopes).toHaveLength(1);
    expect(envelope.meta.ownerPlugin).toBe('slingshot-auth');
    expect(envelope.meta.scope).toEqual({
      tenantId: 'tenant-1',
      userId: 'user-1',
      actorId: 'user-1',
    });
  });

  test('rejects external events that resolve null scope', () => {
    const registry = createEventDefinitionRegistry();
    registry.register(
      defineEvent('auth:logout', {
        ownerPlugin: 'slingshot-auth',
        exposure: ['user-webhook'],
        resolveScope() {
          return null;
        },
      }),
    );
    const publisher = createEventPublisher({
      definitions: registry,
      bus: createInProcessAdapter(),
    });

    expect(() =>
      publisher.publish(
        'auth:logout',
        { userId: 'user-1', sessionId: 'session-1' },
        {
          requestTenantId: null,
        },
      ),
    ).toThrow('resolved a null scope');
  });

  test('uses the default subscriber authorizer when a definition does not provide one', () => {
    const registry = createEventDefinitionRegistry();
    const definition = defineEvent('auth:login', {
      ownerPlugin: 'slingshot-auth',
      exposure: ['user-webhook'],
      resolveScope(payload) {
        return { userId: payload.userId };
      },
    });
    registry.register(definition);
    const publisher = createEventPublisher({
      definitions: registry,
      bus: createInProcessAdapter(),
    });
    const envelope = publisher.publish(
      'auth:login',
      {
        userId: 'user-1',
        sessionId: 'session-1',
      },
      { requestTenantId: null },
    );

    expect(
      authorizeEventSubscriber(definition, { kind: 'user', ownerId: 'user-1' }, envelope),
    ).toBe(true);
    expect(
      authorizeEventSubscriber(definition, { kind: 'user', ownerId: 'user-2' }, envelope),
    ).toBe(false);
  });
});
