import { describe, expect, mock, test } from 'bun:test';
import type { AuthAdapter, RuntimePassword } from '@lastshotlabs/slingshot-core';
import { checkPasswordNotReused, recordPasswordChange } from '../../src/lib/passwordHistory';

function createMockAdapter(overrides: Partial<AuthAdapter> = {}): AuthAdapter {
  return {
    getPasswordHistory: mock(async () => []),
    addPasswordToHistory: mock(async () => {}),
    ...overrides,
  } as unknown as AuthAdapter;
}

const passwordRuntime: RuntimePassword = {
  hash: (plain: string) => Bun.password.hash(plain),
  verify: (plain: string, hash: string) => Bun.password.verify(plain, hash),
};

describe('checkPasswordNotReused', () => {
  test('returns true when history is empty', async () => {
    const adapter = createMockAdapter({
      getPasswordHistory: mock(async () => []),
    });
    const result = await checkPasswordNotReused(adapter, 'user-1', 'newpass', 5, passwordRuntime);
    expect(result).toBe(true);
  });

  test('returns true when maxCount is 0', async () => {
    const adapter = createMockAdapter();
    const result = await checkPasswordNotReused(adapter, 'user-1', 'newpass', 0, passwordRuntime);
    expect(result).toBe(true);
    expect(adapter.getPasswordHistory).not.toHaveBeenCalled();
  });

  test('returns true when maxCount is negative', async () => {
    const adapter = createMockAdapter();
    const result = await checkPasswordNotReused(adapter, 'user-1', 'newpass', -1, passwordRuntime);
    expect(result).toBe(true);
    expect(adapter.getPasswordHistory).not.toHaveBeenCalled();
  });

  test('returns true when adapter does not implement getPasswordHistory', async () => {
    const adapter = createMockAdapter();
    delete (adapter as unknown as Record<string, unknown>).getPasswordHistory;
    const result = await checkPasswordNotReused(adapter, 'user-1', 'newpass', 5, passwordRuntime);
    expect(result).toBe(true);
  });

  test('returns false when password matches a history entry', async () => {
    const hash = await Bun.password.hash('reused-password');
    const adapter = createMockAdapter({
      getPasswordHistory: mock(async () => [hash]),
    });
    const result = await checkPasswordNotReused(
      adapter,
      'user-1',
      'reused-password',
      5,
      passwordRuntime,
    );
    expect(result).toBe(false);
  });

  test('returns true when password does not match any history entry', async () => {
    const hash = await Bun.password.hash('old-password');
    const adapter = createMockAdapter({
      getPasswordHistory: mock(async () => [hash]),
    });
    const result = await checkPasswordNotReused(
      adapter,
      'user-1',
      'completely-new-password',
      5,
      passwordRuntime,
    );
    expect(result).toBe(true);
  });

  test('checks all entries and returns false on second match', async () => {
    const hash1 = await Bun.password.hash('old-password-1');
    const hash2 = await Bun.password.hash('old-password-2');
    const adapter = createMockAdapter({
      getPasswordHistory: mock(async () => [hash1, hash2]),
    });
    const result = await checkPasswordNotReused(
      adapter,
      'user-1',
      'old-password-2',
      5,
      passwordRuntime,
    );
    expect(result).toBe(false);
  });

  test('passes userId to adapter.getPasswordHistory', async () => {
    const getPasswordHistory = mock(async () => []);
    const adapter = createMockAdapter({ getPasswordHistory });
    await checkPasswordNotReused(adapter, 'user-42', 'newpass', 5, passwordRuntime);
    expect(getPasswordHistory).toHaveBeenCalledWith('user-42');
  });

  test('uses Bun.password as default when no passwordRuntime provided', async () => {
    const hash = await Bun.password.hash('test-password');
    const adapter = createMockAdapter({
      getPasswordHistory: mock(async () => [hash]),
    });
    // Omit the passwordRuntime argument — should fall back to Bun.password
    const result = await checkPasswordNotReused(adapter, 'user-1', 'test-password', 5);
    expect(result).toBe(false);
  });

  test('returns true when multiple hashes exist but none match', async () => {
    const hashes = await Promise.all([
      Bun.password.hash('alpha'),
      Bun.password.hash('bravo'),
      Bun.password.hash('charlie'),
    ]);
    const adapter = createMockAdapter({
      getPasswordHistory: mock(async () => hashes),
    });
    const result = await checkPasswordNotReused(adapter, 'user-1', 'delta', 5, passwordRuntime);
    expect(result).toBe(true);
  });
});

describe('recordPasswordChange', () => {
  test('calls adapter.addPasswordToHistory with correct args', async () => {
    const addPasswordToHistory = mock(async () => {});
    const adapter = createMockAdapter({ addPasswordToHistory });
    await recordPasswordChange(adapter, 'user-1', 'hash-abc', 5);
    expect(addPasswordToHistory).toHaveBeenCalledWith('user-1', 'hash-abc', 5);
  });

  test('is no-op when maxCount is 0', async () => {
    const addPasswordToHistory = mock(async () => {});
    const adapter = createMockAdapter({ addPasswordToHistory });
    await recordPasswordChange(adapter, 'user-1', 'hash-abc', 0);
    expect(addPasswordToHistory).not.toHaveBeenCalled();
  });

  test('is no-op when maxCount is negative', async () => {
    const addPasswordToHistory = mock(async () => {});
    const adapter = createMockAdapter({ addPasswordToHistory });
    await recordPasswordChange(adapter, 'user-1', 'hash-abc', -3);
    expect(addPasswordToHistory).not.toHaveBeenCalled();
  });

  test('is no-op when adapter lacks addPasswordToHistory', async () => {
    const adapter = createMockAdapter();
    delete (adapter as unknown as Record<string, unknown>).addPasswordToHistory;
    // Should not throw
    await recordPasswordChange(adapter, 'user-1', 'hash-abc', 5);
  });

  test('passes maxCount through to the adapter', async () => {
    const addPasswordToHistory = mock(async () => {});
    const adapter = createMockAdapter({ addPasswordToHistory });
    await recordPasswordChange(adapter, 'user-1', 'hash-xyz', 10);
    expect(addPasswordToHistory).toHaveBeenCalledWith('user-1', 'hash-xyz', 10);
  });
});
