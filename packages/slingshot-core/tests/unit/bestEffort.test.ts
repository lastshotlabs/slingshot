import { describe, expect, mock, test } from 'bun:test';
import { bestEffort } from '../../src/bestEffort';
import type { Logger } from '../../src/observability/logger';

function makeLogger() {
  const warn = mock((_msg: string, _fields?: Record<string, unknown>) => {});
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn,
    error: () => {},
    child: () => logger,
  };
  return { logger, warn };
}

describe('bestEffort', () => {
  test('does not warn when promise resolves', async () => {
    const { logger, warn } = makeLogger();
    bestEffort(Promise.resolve('ok'), '[test]', logger);
    await new Promise(r => setTimeout(r, 10));
    expect(warn).not.toHaveBeenCalled();
  });

  test('logs warning with label when promise rejects', async () => {
    const { logger, warn } = makeLogger();
    const error = new Error('boom');
    bestEffort(Promise.reject(error), '[identify]', logger);
    await new Promise(r => setTimeout(r, 10));
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('[identify] best-effort operation failed');
    expect(fields).toMatchObject({ err: expect.stringContaining('boom') });
  });

  test('logs warning without label prefix when label is omitted', async () => {
    const { logger, warn } = makeLogger();
    const error = new Error('fail');
    bestEffort(Promise.reject(error), undefined, logger);
    await new Promise(r => setTimeout(r, 10));
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('best-effort operation failed');
    expect(fields).toMatchObject({ err: expect.stringContaining('fail') });
  });

  test('returns void (fire-and-forget)', () => {
    const { logger } = makeLogger();
    const result = bestEffort(Promise.resolve('ok'), '[test]', logger);
    expect(result).toBeUndefined();
  });

  test('handles non-Error rejection values', async () => {
    const { logger, warn } = makeLogger();
    bestEffort(Promise.reject('string-error'), '[label]', logger);
    await new Promise(r => setTimeout(r, 10));
    expect(warn).toHaveBeenCalledTimes(1);
    const [, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({ err: 'string-error' });
  });

  test('uses the noop logger by default — no output to console.warn', async () => {
    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy;
    try {
      bestEffort(Promise.reject(new Error('quiet')), '[default]');
      await new Promise(r => setTimeout(r, 10));
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});
