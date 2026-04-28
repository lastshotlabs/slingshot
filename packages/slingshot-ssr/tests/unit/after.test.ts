import { describe, expect, it } from 'bun:test';
import { buildAfterFn, drainAfterCallbacks, withAfterContext } from '../../src/after/index';

describe('SSR after() queue', () => {
  it('drains callbacks in registration order and clears the request queue', async () => {
    const calls: string[] = [];

    await withAfterContext(async () => {
      const after = buildAfterFn();
      after(() => {
        calls.push('first');
      });
      after(async () => {
        calls.push('second');
      });

      await drainAfterCallbacks();
      await drainAfterCallbacks();
    });

    expect(calls).toEqual(['first', 'second']);
  });

  it('logs callback errors and continues draining later callbacks', async () => {
    const previousError = console.error;
    const errors: unknown[][] = [];
    const calls: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      await withAfterContext(async () => {
        const after = buildAfterFn();
        after(() => {
          throw new Error('after failed');
        });
        after(() => {
          calls.push('continued');
        });

        await drainAfterCallbacks();
      });
    } finally {
      console.error = previousError;
    }

    expect(calls).toEqual(['continued']);
    expect(String(errors[0]?.[0])).toContain('after() callback threw');
  });

  it('warns when after() is called outside an active request context', () => {
    const previousWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      buildAfterFn()(() => {
        throw new Error('should not be queued');
      });
    } finally {
      console.warn = previousWarn;
    }

    expect(warnings[0]).toContain('outside of a request context');
  });
});
