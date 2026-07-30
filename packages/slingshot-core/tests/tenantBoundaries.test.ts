import { describe, expect, test } from 'bun:test';
import {
  captureTenantExecutionContext,
  createTenantBoundaryRegistry,
  deserializeTenantExecutionContext,
  withTenantExecutionContext,
} from '../src';

describe('tenant boundary registry', () => {
  test('is instance-scoped, sorted, frozen, and finalizable', () => {
    const first = createTenantBoundaryRegistry();
    const second = createTenantBoundaryRegistry();
    first.register({
      id: 'events.outbox',
      kind: 'event',
      requiredIn: ['single', 'multi'],
      serialization: 'envelope',
      missing: 'reject',
      mismatch: 'reject',
    });
    expect(second.list()).toEqual([]);
    const inventory = first.finalize();
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(() => first.register(inventory[0]!)).toThrow('finalized');
  });

  test('rejects duplicate boundary ids', () => {
    const registry = createTenantBoundaryRegistry();
    const definition = {
      id: 'http.request',
      kind: 'http' as const,
      requiredIn: ['multi'] as const,
      serialization: 'scope' as const,
      missing: 'reject' as const,
      mismatch: 'reject' as const,
    };
    registry.register(definition);
    expect(() => registry.register(definition)).toThrow('Duplicate');
  });
});

describe('tenant execution context snapshots', () => {
  test('round-trips immutable identity without global state', async () => {
    const snapshot = captureTenantExecutionContext({
      tenantId: 'tenant-a',
      actorId: 'user-1',
      requestId: 'request-1',
      correlationId: 'correlation-1',
      causationId: 'event-1',
      idempotencyKey: 'idem-1',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(deserializeTenantExecutionContext(JSON.parse(JSON.stringify(snapshot)))).toEqual(
      snapshot,
    );
    await expect(
      withTenantExecutionContext(snapshot, async restored => restored.tenantId),
    ).resolves.toBe('tenant-a');
  });

  test('rejects missing, malformed, and unsupported snapshots', () => {
    expect(() => captureTenantExecutionContext({ tenantId: null })).toThrow('tenantId');
    expect(() => deserializeTenantExecutionContext('spoofed')).toThrow('Malformed');
    expect(() => deserializeTenantExecutionContext({ version: 2, tenantId: 'stale' })).toThrow(
      'Unsupported',
    );
  });
});
