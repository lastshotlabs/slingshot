import { describe, expect, test } from 'bun:test';
import { createMemoryPermissionsAdapter } from '../../src/testing';

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

  test('can be called multiple times (independent instances)', () => {
    const a1 = createMemoryPermissionsAdapter();
    const a2 = createMemoryPermissionsAdapter();
    expect(a1).not.toBe(a2);
  });

  test('returns adapter with getGrantsForRole', () => {
    const adapter = createMemoryPermissionsAdapter();
    expect(typeof adapter.getGrantsForRole).toBe('function');
  });

  test('getGrantsForRole returns empty array for unknown role', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const grants = await adapter.getGrantsForRole('nonexistent');
    expect(grants).toEqual([]);
  });
});
