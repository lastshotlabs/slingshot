import { describe, expect, test } from 'bun:test';
import { PermissionQueryTimeoutError } from '../../src/lib/evaluator';

describe('PermissionQueryTimeoutError', () => {
  test('has correct name', () => {
    const err = new PermissionQueryTimeoutError('test-adapter', 5000);
    expect(err.name).toBe('PermissionQueryTimeoutError');
  });

  test('is instance of Error', () => {
    const err = new PermissionQueryTimeoutError('test-adapter', 5000);
    expect(err).toBeInstanceOf(Error);
  });

  test('includes adapter name in message', () => {
    const err = new PermissionQueryTimeoutError('pg-adapter', 3000);
    expect(err.message).toContain('pg-adapter');
  });

  test('includes timeout in message', () => {
    const err = new PermissionQueryTimeoutError('adapter', 5000);
    expect(err.message).toContain('5000');
  });

  test('exposes adapter and timeoutMs properties', () => {
    const err = new PermissionQueryTimeoutError('my-adapter', 10000);
    expect(err.adapter).toBe('my-adapter');
    expect(err.timeoutMs).toBe(10000);
  });

  test('can be caught with instanceof', () => {
    try {
      throw new PermissionQueryTimeoutError('adapter', 1000);
    } catch (e) {
      expect(e instanceof PermissionQueryTimeoutError).toBe(true);
    }
  });

  test('can be discriminated from regular Error', () => {
    const permErr = new PermissionQueryTimeoutError('a', 100);
    const regErr = new Error('something');
    expect(permErr instanceof PermissionQueryTimeoutError).toBe(true);
    expect(regErr instanceof PermissionQueryTimeoutError).toBe(false);
  });
});
