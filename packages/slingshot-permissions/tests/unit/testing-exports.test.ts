import { describe, expect, test } from 'bun:test';
import { createMemoryPermissionsAdapter } from '../../src/testing';
import type { PermissionsMemoryAdapter } from '../../src/testing';

describe('createMemoryPermissionsAdapter', () => {
  test('returns adapter with getGrants', async () => {
    const adapter = createMemoryPermissionsAdapter();
    expect(typeof adapter.getGrants).toBe('function');
    expect(typeof adapter.close).toBe('function');
  });

  test('getGrants returns empty array for unknown subject', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const grants = await adapter.getGrants('unknown');
    expect(grants).toEqual([]);
    await adapter.close();
  });

  test('close does not throw', async () => {
    const adapter = createMemoryPermissionsAdapter();
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  test('can be called multiple times (independent instances)', async () => {
    const a1 = createMemoryPermissionsAdapter();
    const a2 = createMemoryPermissionsAdapter();
    expect(a1).not.toBe(a2);
    await a1.close();
    await a2.close();
  });
});
