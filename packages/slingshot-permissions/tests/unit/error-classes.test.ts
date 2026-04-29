import { describe, expect, test } from 'bun:test';
import { PermissionQueryTimeoutError } from '../../src/lib/evaluator';

describe('PermissionQueryTimeoutError', () => {
  test('has correct name', () => {
    const err = new PermissionQueryTimeoutError('timeout from pg', {
      adapter: 'pg-adapter',
      timeoutMs: 5000,
    });
    expect(err.name).toBe('PermissionQueryTimeoutError');
  });

  test('is instance of Error', () => {
    const err = new PermissionQueryTimeoutError('timeout', {
      adapter: 'test',
      timeoutMs: 3000,
    });
    expect(err).toBeInstanceOf(Error);
  });

  test('includes adapter name in message', () => {
    const err = new PermissionQueryTimeoutError('adapter pg-adapter timed out', {
      adapter: 'pg-adapter',
      timeoutMs: 3000,
    });
    expect(err.message).toContain('pg-adapter');
  });

  test('exposes adapter and timeoutMs from context', () => {
    const err = new PermissionQueryTimeoutError('timeout', {
      adapter: 'my-adapter',
      timeoutMs: 10000,
    });
    expect(err.adapter).toBe('my-adapter');
    expect(err.timeoutMs).toBe(10000);
  });

  test('exposes optional scope and subjectId', () => {
    const err = new PermissionQueryTimeoutError('timeout', {
      adapter: 'adapter',
      timeoutMs: 1000,
      scope: { tenantId: 'tenant-1' },
      subjectId: 'user-123',
    });
    expect(err.scope).toEqual({ tenantId: 'tenant-1' });
    expect(err.subjectId).toBe('user-123');
  });

  test('can be caught with instanceof', () => {
    try {
      throw new PermissionQueryTimeoutError('timeout', {
        adapter: 'adapter',
        timeoutMs: 1000,
      });
    } catch (e) {
      expect(e instanceof PermissionQueryTimeoutError).toBe(true);
    }
  });

  test('can be discriminated from regular Error', () => {
    const permErr = new PermissionQueryTimeoutError('timeout', {
      adapter: 'a',
      timeoutMs: 100,
    });
    const regErr = new Error('something');
    expect(permErr instanceof PermissionQueryTimeoutError).toBe(true);
    expect(regErr instanceof PermissionQueryTimeoutError).toBe(false);
  });
});
