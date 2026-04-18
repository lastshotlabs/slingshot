import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { beforeEach, describe, expect, test } from 'bun:test';

let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

beforeEach(() => {
  memoryAuthAdapter = createMemoryAuthAdapter();
});

describe('adapter profile — memoryAuth', () => {
  test('updateProfile sets displayName', async () => {
    const { id } = await memoryAuthAdapter.create('test@example.com', 'hash');
    await memoryAuthAdapter.updateProfile!(id, { displayName: 'Test User' });
    const user = await memoryAuthAdapter.getUser!(id);
    expect(user?.displayName).toBe('Test User');
  });

  test('setSuspended and getSuspended', async () => {
    const { id } = await memoryAuthAdapter.create('test@example.com', 'hash');
    await memoryAuthAdapter.setSuspended!(id, true, 'Violation');
    const status = await memoryAuthAdapter.getSuspended!(id);
    expect(status?.suspended).toBe(true);
    expect(status?.suspendedReason).toBe('Violation');
  });

  test('unsuspend clears reason', async () => {
    const { id } = await memoryAuthAdapter.create('test@example.com', 'hash');
    await memoryAuthAdapter.setSuspended!(id, true, 'Reason');
    await memoryAuthAdapter.setSuspended!(id, false);
    const status = await memoryAuthAdapter.getSuspended!(id);
    expect(status?.suspended).toBe(false);
    expect(status?.suspendedReason).toBeUndefined();
  });

  test('listUsers returns all users', async () => {
    await memoryAuthAdapter.create('a@example.com', 'h1');
    await memoryAuthAdapter.create('b@example.com', 'h2');
    const result = await memoryAuthAdapter.listUsers!({});
    expect(result.totalResults).toBe(2);
    expect(result.users.length).toBe(2);
  });

  test('listUsers filters by suspended', async () => {
    const { id } = await memoryAuthAdapter.create('a@example.com', 'h1');
    await memoryAuthAdapter.create('b@example.com', 'h2');
    await memoryAuthAdapter.setSuspended!(id, true);
    const result = await memoryAuthAdapter.listUsers!({ suspended: true });
    expect(result.totalResults).toBe(1);
    expect(result.users[0].email).toBe('a@example.com');
  });

  test('listUsers filters by email', async () => {
    await memoryAuthAdapter.create('a@example.com', 'h1');
    await memoryAuthAdapter.create('b@example.com', 'h2');
    const result = await memoryAuthAdapter.listUsers!({ email: 'a@example.com' });
    expect(result.totalResults).toBe(1);
    expect(result.users[0].email).toBe('a@example.com');
  });

  test('listUsers pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await memoryAuthAdapter.create(`user${i}@example.com`, 'hash');
    }
    const page1 = await memoryAuthAdapter.listUsers!({ startIndex: 0, count: 2 });
    expect(page1.users.length).toBe(2);
    expect(page1.totalResults).toBe(5);
  });
});
