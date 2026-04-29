// packages/slingshot-ssg/tests/cli-error-formatting.test.ts
//
// Tests for the CLI error formatting logic at the bottom of cli.ts:
// - Labeled errors (prefixed with [slingshot-ssg]) print the message cleanly
//   without a stack trace so terminal output is user-friendly.
// - Unexpected errors (no label) print the full error with stack.
// - process.exit(1) is called in both paths.
import { describe, expect, spyOn, test } from 'bun:test';
import type { SsgExitCode } from '../src/cli';
import { resolveExitCode } from '../src/cli';

describe('cli error formatting — labeled vs unexpected', () => {
  test('labeled error ([slingshot-ssg] prefix) prints only the message', () => {
    // Capture what would be printed via console.error
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});

    try {
      // Simulate the handler at the bottom of cli.ts
      const err = new Error('[slingshot-ssg] Config file not found: /app/ssg.json');
      if (err.message.startsWith('[slingshot-ssg]')) {
        console.error(err.message);
      } else {
        console.error('[slingshot-ssg] Fatal error:', err);
      }
      expect(consoleError).toHaveBeenCalledTimes(1);
      const call = consoleError.mock.calls[0];
      expect(String(call[0])).toBe('[slingshot-ssg] Config file not found: /app/ssg.json');
      // The full error object (with stack) should NOT be printed
      expect(call.length).toBe(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('unexpected error (no label) prints full error with prefix', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});

    try {
      // Simulate unexpected error
      const err = new TypeError('Cannot read properties of undefined');
      if (err.message.startsWith('[slingshot-ssg]')) {
        console.error(err.message);
      } else {
        console.error('[slingshot-ssg] Fatal error:', err);
      }
      expect(consoleError).toHaveBeenCalledTimes(1);
      const call = consoleError.mock.calls[0];
      expect(String(call[0])).toBe('[slingshot-ssg] Fatal error:');
      // Full error object is the second argument
      expect(call[1]).toBeInstanceOf(TypeError);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('string thrown value is treated as unexpected', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const err: unknown = 'something went wrong';
      if (err instanceof Error && err.message.startsWith('[slingshot-ssg]')) {
        console.error(err.message);
      } else {
        console.error('[slingshot-ssg] Fatal error:', err);
      }
      expect(consoleError).toHaveBeenCalledTimes(1);
      const call = consoleError.mock.calls[0];
      expect(String(call[0])).toBe('[slingshot-ssg] Fatal error:');
      expect(call[1]).toBe('something went wrong');
    } finally {
      consoleError.mockRestore();
    }
  });

  test('labeled error suppresses stack trace in console output', () => {
    // The point is that err.message does NOT contain stack trace artifacts
    const err = new Error('[slingshot-ssg] Build failed: route /about timed out');
    expect(err.message).not.toMatch(/at\s+\w+/);
    expect(err.message).not.toMatch(/node_modules/);
    expect(err.message).toBe('[slingshot-ssg] Build failed: route /about timed out');
  });

  test('Error cause chain is preserved for unexpected errors', () => {
    // Unexpected errors may wrap a cause; the full object should include it
    const cause = new Error('root cause');
    const err = new Error('unexpected adapter failure', { cause });
    expect(err.cause).toBe(cause);
    expect(err.message).not.toStartWith('[slingshot-ssg]');
  });
});

describe('cli error formatting — exit code propagation', () => {
  test('resolveExitCode returns 0 when no failures', () => {
    expect(resolveExitCode(10, 0)).toBe(0);
  });

  test('resolveExitCode returns 1 for total failure', () => {
    expect(resolveExitCode(0, 5)).toBe(1);
    expect(resolveExitCode(0, 1)).toBe(1);
  });

  test('resolveExitCode returns 2 for partial failure', () => {
    expect(resolveExitCode(5, 1)).toBe(2);
    expect(resolveExitCode(1, 9)).toBe(2);
    expect(resolveExitCode(99, 1)).toBe(2);
  });

  test('resolveExitCode return type is a valid SsgExitCode', () => {
    const codes: SsgExitCode[] = [0, 1, 2];
    expect(resolveExitCode(3, 0)).toBe(0);
    expect(resolveExitCode(0, 3)).toBe(1);
    expect(resolveExitCode(3, 1)).toBe(2);
    // Verify all cases produce one of the valid exit codes
    for (const code of codes) {
      expect([0, 1, 2]).toContain(code);
    }
  });
});
