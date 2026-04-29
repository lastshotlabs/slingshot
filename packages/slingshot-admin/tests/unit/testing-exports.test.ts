import { describe, expect, test } from 'bun:test';
import { createMemoryAccessProvider, createMemoryManagedUserProvider } from '../../src/testing';
import type { AdminAccessProvider, ManagedUserProvider } from '@lastshotlabs/slingshot-core';

describe('createMemoryAccessProvider', () => {
  test('returns an AdminAccessProvider', () => {
    const provider = createMemoryAccessProvider();
    expect(typeof provider.checkAccess).toBe('function');
  });

  test('checkAccess returns true for any subject by default', async () => {
    const provider = createMemoryAccessProvider();
    const result = await provider.checkAccess({ id: 'any-user' } as any);
    expect(result).toBe(true);
  });
});

describe('createMemoryManagedUserProvider', () => {
  test('returns a ManagedUserProvider', () => {
    const provider = createMemoryManagedUserProvider();
    expect(typeof provider.getUsers).toBe('function');
    expect(typeof provider.getUser).toBe('function');
  });

  test('getUsers returns empty array by default', async () => {
    const provider = createMemoryManagedUserProvider();
    const result = await provider.getUsers({} as any);
    expect(result.users).toEqual([]);
  });

  test('getUser returns null for unknown id', async () => {
    const provider = createMemoryManagedUserProvider();
    const result = await provider.getUser('unknown');
    expect(result).toBeNull();
  });
});
