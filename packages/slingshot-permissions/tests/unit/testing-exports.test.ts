import { describe, expect, test } from 'bun:test';
import { createMemoryPermissionsAdapter } from '../../src/testing';
import type { PermissionsMemoryAdapter } from '../../src/testing';

describe('createMemoryPermissionsAdapter', () => {
  test('returns adapter with getGrantsForSubject', () => {
    const adapter = createMemoryPermissionsAdapter();
    expect(typeof adapter.getGrantsForSubject).toBe('function');
  });

  test('getGrantsForSubject returns empty array for unknown subject', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const grants = await adapter.getGrantsForSubject({ type: 'user', id: 'unknown' });
    expect(grants).toEqual([]);
  });

  test('returns adapter with clear method for test teardown', () => {
    const adapter = createMemoryPermissionsAdapter();
    expect(typeof adapter.clear).toBe('function');
  });

  test('can be called multiple times (independent instances)', () => {
    const a1 = createMemoryPermissionsAdapter();
    const a2 = createMemoryPermissionsAdapter();
    expect(a1).not.toBe(a2);
  });

  test('clear does not throw', () => {
    const adapter = createMemoryPermissionsAdapter();
    expect(() => adapter.clear()).not.toThrow();
  });

  test('clear resets grants', async () => {
    const adapter = createMemoryPermissionsAdapter();
    await adapter.getGrantsForSubject({ type: 'user', id: 'test' });
    adapter.clear();
    const grants = await adapter.getGrantsForSubject({ type: 'user', id: 'test' });
    expect(grants).toEqual([]);
  });
});
