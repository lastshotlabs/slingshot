/**
 * Tests src/lib/logger.ts.
 *
 * The `verbose` flag in logger.ts is computed at module load time from
 * process.env.LOGGING_VERBOSE. In this project's .env, LOGGING_VERBOSE is set
 * to an empty string which evaluates to verbose=false. The tests below verify
 * the silent (verbose=false) path and that calling log() never throws.
 *
 * The verbose=true path (console.log call) is exercised in environments where
 * LOGGING_VERBOSE is unset (e.g., CI without a .env file), where isDev=true
 * causes verbose to default to true.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { authTrace, log } from '../../src/framework/lib/logger';

const originalLoggingAuthTrace = process.env.LOGGING_AUTH_TRACE;

afterEach(() => {
  process.env.LOGGING_AUTH_TRACE = originalLoggingAuthTrace;
});

describe('log', () => {
  test('is exported as a function', () => {
    expect(typeof log).toBe('function');
  });

  test('can be called with no arguments without throwing', () => {
    expect(() => log()).not.toThrow();
  });

  test('can be called with a single string argument without throwing', () => {
    expect(() => log('hello')).not.toThrow();
  });

  test('can be called with multiple mixed-type arguments without throwing', () => {
    expect(() => log('label:', 42, { key: 'value' }, [1, 2])).not.toThrow();
  });

  test('verbose flag controls console.log calls', () => {
    // setup.ts sets LOGGING_VERBOSE="true" before logger.ts initializes,
    // so verbose=true and log() calls console.log.
    // This test verifies log() goes through console.log when verbose is enabled.
    let called = false;
    const orig = console.log;
    console.log = () => {
      called = true;
    };
    try {
      log('should go through console.log when verbose=true');
      expect(called).toBe(true);
    } finally {
      console.log = orig;
    }
  });

  test('authTrace reads LOGGING_AUTH_TRACE at call time', () => {
    const calls: unknown[][] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      process.env.LOGGING_AUTH_TRACE = 'false';
      authTrace('suppressed');

      process.env.LOGGING_AUTH_TRACE = 'true';
      authTrace('visible');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(['visible']);
    } finally {
      console.log = orig;
    }
  });
});
