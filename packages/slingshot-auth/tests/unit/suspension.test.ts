import { describe, expect, mock, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import { getSuspended, setSuspended } from '../../src/lib/suspension';

function createMockAdapter(overrides: Partial<AuthAdapter> = {}): AuthAdapter {
  return {
    ...overrides,
  } as unknown as AuthAdapter;
}

describe('getSuspended', () => {
  test('returns { suspended: false } when adapter does not implement getSuspended', async () => {
    const adapter = createMockAdapter();
    const result = await getSuspended(adapter, 'user-1');
    expect(result).toEqual({ suspended: false });
  });

  test('returns { suspended: false } when adapter.getSuspended returns null', async () => {
    const adapter = createMockAdapter({
      getSuspended: mock(async () => null),
    });
    const result = await getSuspended(adapter, 'user-1');
    expect(result).toEqual({ suspended: false });
  });

  test('returns suspension status from adapter when suspended is true', async () => {
    const adapter = createMockAdapter({
      getSuspended: mock(async () => ({ suspended: true })),
    });
    const result = await getSuspended(adapter, 'user-1');
    expect(result).toEqual({ suspended: true });
  });

  test('returns suspension status from adapter when suspended is false', async () => {
    const adapter = createMockAdapter({
      getSuspended: mock(async () => ({ suspended: false })),
    });
    const result = await getSuspended(adapter, 'user-1');
    expect(result).toEqual({ suspended: false });
  });

  test('includes suspendedReason when present', async () => {
    const adapter = createMockAdapter({
      getSuspended: mock(async () => ({
        suspended: true,
        suspendedReason: 'Violated terms of service',
      })),
    });
    const result = await getSuspended(adapter, 'user-1');
    expect(result).toEqual({ suspended: true, suspendedReason: 'Violated terms of service' });
  });

  test('passes userId to adapter.getSuspended', async () => {
    const getSuspendedMock = mock(async () => ({ suspended: false }));
    const adapter = createMockAdapter({ getSuspended: getSuspendedMock });
    await getSuspended(adapter, 'user-42');
    expect(getSuspendedMock).toHaveBeenCalledWith('user-42');
  });
});

describe('setSuspended', () => {
  test('calls adapter.setSuspended with correct args', async () => {
    const setSuspendedMock = mock(async () => {});
    const adapter = createMockAdapter({
      setSuspended: setSuspendedMock,
    });
    await setSuspended(adapter, 'user-1', true);
    expect(setSuspendedMock).toHaveBeenCalledWith('user-1', true, undefined);
  });

  test('is no-op when adapter does not implement setSuspended', async () => {
    const adapter = createMockAdapter();
    // Should not throw
    await setSuspended(adapter, 'user-1', true);
  });

  test('passes reason when provided', async () => {
    const setSuspendedMock = mock(async () => {});
    const adapter = createMockAdapter({
      setSuspended: setSuspendedMock,
    });
    await setSuspended(adapter, 'user-1', true, 'Spam account');
    expect(setSuspendedMock).toHaveBeenCalledWith('user-1', true, 'Spam account');
  });

  test('calls adapter with suspended=false to unsuspend', async () => {
    const setSuspendedMock = mock(async () => {});
    const adapter = createMockAdapter({
      setSuspended: setSuspendedMock,
    });
    await setSuspended(adapter, 'user-1', false);
    expect(setSuspendedMock).toHaveBeenCalledWith('user-1', false, undefined);
  });
});
