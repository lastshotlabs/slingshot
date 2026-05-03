import { afterEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  createEventSchemaRegistry,
  createInProcessAdapter,
  validateEventPayload,
} from '../../src/index';

afterEach(() => {
  mock.restore();
});

describe('eventSchemaRegistry', () => {
  test('registers schemas and validates transformed payloads', () => {
    const registry = createEventSchemaRegistry();
    registry.register(
      'auth:user.created',
      z.object({
        userId: z.string().transform(value => value.toUpperCase()),
      }),
    );

    expect(registry.has('auth:user.created')).toBe(true);
    expect(registry.size).toBe(1);
    expect([...registry.keys()]).toEqual(['auth:user.created']);

    const result = registry.validate('auth:user.created', { userId: 'user-1' });
    expect(result).toEqual({
      success: true,
      data: { userId: 'USER-1' },
    });
  });

  test('rejects duplicate schema registration for the same event key', () => {
    const registry = createEventSchemaRegistry();
    registry.register('auth:login', z.object({ userId: z.string() }));

    expect(() => {
      registry.register('auth:login', z.object({ userId: z.string() }));
    }).toThrow('schema already registered');
  });

  test('warn mode logs and returns the original invalid payload', () => {
    const registry = createEventSchemaRegistry();
    registry.register('auth:login', z.object({ userId: z.string(), sessionId: z.string() }));

    const warn = mock((_msg: string, _fields?: Record<string, unknown>) => {});
    const logger = {
      debug: () => {},
      info: () => {},
      warn,
      error: () => {},
      child: () => logger,
    };

    const payload = { userId: 'u-1' };
    expect(validateEventPayload('auth:login', payload, registry, 'warn', logger as never)).toBe(
      payload,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('InProcessAdapter schema validation', () => {
  test('validates and transforms payloads before invoking listeners', async () => {
    const registry = createEventSchemaRegistry();
    registry.register(
      'auth:login',
      z.object({
        userId: z.string().transform(value => value.toUpperCase()),
        sessionId: z.string(),
      }),
    );

    const bus = createInProcessAdapter({
      schemaRegistry: registry,
      validation: 'strict',
    });
    const received: Array<{ userId: string; sessionId: string }> = [];

    bus.on('auth:login', payload => {
      received.push(payload);
    });
    bus.emit('auth:login', { userId: 'user-2', sessionId: 'session-2' });

    await Promise.resolve();
    expect(received).toEqual([{ userId: 'USER-2', sessionId: 'session-2' }]);
  });

  test('strict mode throws before dispatching invalid payloads', () => {
    const registry = createEventSchemaRegistry();
    registry.register('auth:login', z.object({ userId: z.string(), sessionId: z.string() }));

    const bus = createInProcessAdapter({
      schemaRegistry: registry,
      validation: 'strict',
    });
    const listener = mock(() => {});

    bus.on('auth:login', listener);

    expect(() => {
      bus.emit('auth:login', { userId: 'user-3' } as never);
    }).toThrow('validation failed');
    expect(listener).not.toHaveBeenCalled();
  });
});
