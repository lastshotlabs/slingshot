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

  test('memory factory returns adapter with required methods', async () => {
    const adapter = await permissionsAdapterFactories.memory({});
    expect(typeof adapter.getGrants).toBe('function');
    expect(typeof adapter.close).toBe('function');
  });

  test('memory factory works without options', async () => {
    const adapter = await permissionsAdapterFactories.memory({});
    expect(adapter).toBeDefined();
    await adapter.close();
  });

  test('memory adapter starts with empty grants', async () => {
    const adapter = await permissionsAdapterFactories.memory({});
    const grants = await adapter.getGrants('any-subject');
    expect(Array.isArray(grants)).toBe(true);
    await adapter.close();
  });
});
