import { describe, expect, test } from 'bun:test';
import { permissionsAdapterFactories } from '../../src/factories';

describe('permissionsAdapterFactories', () => {
  test('contains memory adapter factory', () => {
    expect(permissionsAdapterFactories).toHaveProperty('memory');
    expect(typeof permissionsAdapterFactories.memory).toBe('function');
  });

  test('contains postgres adapter factory', () => {
    expect(permissionsAdapterFactories).toHaveProperty('postgres');
    expect(typeof permissionsAdapterFactories.postgres).toBe('function');
  });

  test('contains sqlite adapter factory', () => {
    expect(permissionsAdapterFactories).toHaveProperty('sqlite');
    expect(typeof permissionsAdapterFactories.sqlite).toBe('function');
  });

  test('contains mongo adapter factory', () => {
    expect(permissionsAdapterFactories).toHaveProperty('mongo');
    expect(typeof permissionsAdapterFactories.mongo).toBe('function');
  });

  test('contains redis adapter factory (throws on call)', () => {
    expect(permissionsAdapterFactories).toHaveProperty('redis');
    expect(typeof permissionsAdapterFactories.redis).toBe('function');
    expect(() => permissionsAdapterFactories.redis({} as any)).toThrow();
  });

  test('memory factory returns adapter with getGrantsForSubject', async () => {
    const adapter = await permissionsAdapterFactories.memory({} as any);
    expect(typeof adapter.getGrantsForSubject).toBe('function');
    expect(typeof adapter.clear).toBe('function');
  });

  test('memory factory works without store infra details', async () => {
    const adapter = await permissionsAdapterFactories.memory({} as any);
    expect(adapter).toBeDefined();
  });

  test('memory adapter starts with empty grants', async () => {
    const adapter = await permissionsAdapterFactories.memory({} as any);
    const grants = await adapter.getGrantsForSubject({ type: 'user', id: 'any-subject' });
    expect(Array.isArray(grants)).toBe(true);
    expect(grants).toEqual([]);
  });
});
