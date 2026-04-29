import { describe, expect, test } from 'bun:test';
import { createMemoryAccessProvider, createMemoryManagedUserProvider } from '../../src/testing';

describe('createMemoryAccessProvider', () => {
  test('returns a provider with verifyRequest method', () => {
    const provider = createMemoryAccessProvider();
    expect(typeof provider.verifyRequest).toBe('function');
  });

  test('verifyRequest returns a principal by default', async () => {
    const provider = createMemoryAccessProvider();
    const result = await provider.verifyRequest(new Request('http://localhost'));
    expect(result).not.toBeNull();
    expect(result?.subject).toBe('test-admin');
  });

  test('unauthenticated option returns null', async () => {
    const provider = createMemoryAccessProvider({ unauthenticated: true });
    const result = await provider.verifyRequest(new Request('http://localhost'));
    expect(result).toBeNull();
  });

  test('custom principal is returned', async () => {
    const provider = createMemoryAccessProvider({
      principal: { subject: 'custom-user', email: 'custom@test.local', provider: 'test' },
    });
    const result = await provider.verifyRequest(new Request('http://localhost'));
    expect(result?.subject).toBe('custom-user');
  });
});

describe('createMemoryManagedUserProvider', () => {
  test('has a name property', () => {
    const provider = createMemoryManagedUserProvider();
    expect(provider.name).toBe('memory');
  });

  test('has listUsers method', () => {
    const provider = createMemoryManagedUserProvider();
    expect(typeof provider.listUsers).toBe('function');
  });

  test('has getUser method', () => {
    const provider = createMemoryManagedUserProvider();
    expect(typeof provider.getUser).toBe('function');
  });

  test('listUsers returns paginated result', async () => {
    const provider = createMemoryManagedUserProvider();
    const result = await provider.listUsers({});
    expect(result).toHaveProperty('items');
    expect(Array.isArray(result.items)).toBe(true);
  });

  test('getUser returns null for unknown id', async () => {
    const provider = createMemoryManagedUserProvider();
    const result = await provider.getUser('unknown');
    expect(result).toBeNull();
  });

  test('clear does not throw', () => {
    const provider = createMemoryManagedUserProvider();
    expect(() => provider.clear()).not.toThrow();
  });
});
