import { describe, expect, test } from 'bun:test';
import { createMemoryManagedUserProvider } from '../../src/providers/memoryAccess';

describe('createMemoryManagedUserProvider', () => {
  test('searchUsers works when destructured from the provider', async () => {
    const provider = createMemoryManagedUserProvider();
    provider.seedUser({
      id: 'user-1',
      tenantId: 'tenant-a',
      email: 'alice@example.com',
      displayName: 'Alice',
      provider: 'memory',
      status: 'active',
    });
    provider.seedUser({
      id: 'user-2',
      tenantId: 'tenant-a',
      email: 'bob@example.com',
      displayName: 'Bob',
      provider: 'memory',
      status: 'active',
    });

    const { searchUsers } = provider;
    const result = await searchUsers('alice', { tenantId: 'tenant-a' });

    expect(result.items.map(user => user.id)).toEqual(['user-1']);
  });
});
