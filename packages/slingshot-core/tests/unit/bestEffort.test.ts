import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { bestEffort } from '../../src/bestEffort';

describe('bestEffort', () => {
  let originalWarn: typeof console.warn;
  let warnMock: ReturnType<typeof mock>;

  beforeEach(() => {
    originalWarn = console.warn;
    warnMock = mock(() => {});
    console.warn = warnMock;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test('does not throw when promise resolves', async () => {
    bestEffort(Promise.resolve('ok'), '[test]');
    // Allow microtask to settle
    await new Promise(r => setTimeout(r, 10));
    expect(warnMock).not.toHaveBeenCalled();
  });

  test('logs warning with label when promise rejects', async () => {
    const error = new Error('boom');
    bestEffort(Promise.reject(error), '[identify]');
    await new Promise(r => setTimeout(r, 10));
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toBe('[identify] best-effort operation failed:');
    expect(warnMock.mock.calls[0][1]).toBe(error);
  });

  test('logs warning without label when label is omitted', async () => {
    const error = new Error('fail');
    bestEffort(Promise.reject(error));
    await new Promise(r => setTimeout(r, 10));
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toBe('best-effort operation failed:');
    expect(warnMock.mock.calls[0][1]).toBe(error);
  });

  test('returns void (fire-and-forget)', () => {
    const result = bestEffort(Promise.resolve('ok'), '[test]');
    expect(result).toBeUndefined();
  });

  test('handles non-Error rejection values', async () => {
    bestEffort(Promise.reject('string-error'), '[label]');
    await new Promise(r => setTimeout(r, 10));
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][1]).toBe('string-error');
  });
});
