import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Logger } from '@lastshotlabs/slingshot-core';
import {
  configureRuntimeBunLogger,
  configureRuntimeBunStructuredLogger,
  installProcessSafetyNet,
  resetProcessSafetyNetForTest,
} from '../src/index';
import type { RuntimeBunLogger } from '../src/index';

describe('runtime-bun logging', () => {
  beforeEach(() => {
    resetProcessSafetyNetForTest();
  });

  afterEach(() => {
    resetProcessSafetyNetForTest();
    configureRuntimeBunLogger(null);
    configureRuntimeBunStructuredLogger(null);
  });

  test('configureRuntimeBunLogger replaces the active logger and returns the previous one', () => {
    const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const custom: RuntimeBunLogger = {
      warn() {},
      error(event, fields) {
        logged.push({ event, fields });
      },
    };
    const previous = configureRuntimeBunLogger(custom);
    // previous should be the default logger with warn/error methods
    expect(previous).toHaveProperty('warn');
    expect(previous).toHaveProperty('error');
    expect(typeof previous.warn).toBe('function');
    expect(typeof previous.error).toBe('function');

    // Verify custom logger receives events
    installProcessSafetyNet();
    process.emit('unhandledRejection', new Error('logger-swap'), Promise.resolve());
    expect(logged.some(e => e.event === 'unhandled-rejection')).toBe(true);

    // Restore original
    configureRuntimeBunLogger(previous);
  });

  test('configureRuntimeBunLogger(null) resets to default console logger', () => {
    const customLogged: Array<{ event: string }> = [];
    const custom: RuntimeBunLogger = {
      warn() {},
      error(event) {
        customLogged.push({ event });
      },
    };
    configureRuntimeBunLogger(custom);
    configureRuntimeBunLogger(null); // reset

    // After reset, custom should NOT receive events
    installProcessSafetyNet();
    process.emit('unhandledRejection', new Error('post-reset'), Promise.resolve());
    expect(customLogged.some(e => e.event === 'unhandled-rejection')).toBe(false);
  });

  test('configureRuntimeBunLogger return value enables save/restore pattern', () => {
    const first: RuntimeBunLogger = {
      warn() {},
      error() {},
    };
    const second: RuntimeBunLogger = {
      warn() {},
      error() {},
    };

    const prev1 = configureRuntimeBunLogger(first);
    const prev2 = configureRuntimeBunLogger(second);
    // prev2 should be first
    expect(prev2).toBe(first);

    // Restore to first
    const prev3 = configureRuntimeBunLogger(prev2);
    expect(prev3).toBe(second);
  });

  test('configureRuntimeBunStructuredLogger replaces the structured logger and returns previous', () => {
    const received: Array<{ event: string; fields: Record<string, unknown> }> = [];
    let capturedChild: Logger | null = null;
    const custom: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(event, fields: Record<string, unknown>) {
        received.push({ event, fields });
      },
      child() {
        return custom;
      },
    };

    const previous = configureRuntimeBunStructuredLogger(custom);
    expect(typeof previous.debug).toBe('function');
    expect(typeof previous.error).toBe('function');

    installProcessSafetyNet();
    process.emit('unhandledRejection', new Error('struct-log'), Promise.resolve());
    expect(received.some(e => e.event === 'unhandled-rejection')).toBe(true);
    expect(received.some(e => e.fields?.message === 'struct-log')).toBe(true);

    configureRuntimeBunStructuredLogger(previous);
  });

  test('configureRuntimeBunStructuredLogger(null) resets to default', () => {
    const received: Array<{ event: string }> = [];
    const custom: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(event: string) {
        received.push({ event });
      },
      child() {
        return custom;
      },
    };

    configureRuntimeBunStructuredLogger(custom);
    configureRuntimeBunStructuredLogger(null); // reset

    installProcessSafetyNet();
    process.emit('unhandledRejection', new Error('post-reset-struct'), Promise.resolve());
    expect(received.some(e => e.event === 'unhandled-rejection')).toBe(false);
  });

  test('both loggers receive process safety events independently', () => {
    const runtimeEvents: Array<{ event: string }> = [];
    const structuredEvents: Array<{ event: string }> = [];
    let capturedChild: Logger | null = null;

    const customRuntime: RuntimeBunLogger = {
      warn() {},
      error(event) {
        runtimeEvents.push({ event });
      },
    };
    const customStructured: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(event: string) {
        structuredEvents.push({ event });
      },
      child() {
        return customStructured;
      },
    };

    configureRuntimeBunLogger(customRuntime);
    configureRuntimeBunStructuredLogger(customStructured);
    installProcessSafetyNet();

    process.emit('unhandledRejection', new Error('both-loggers'), Promise.resolve());
    process.emit('uncaughtException', new Error('both-loggers-exc'));

    expect(runtimeEvents.some(e => e.event === 'unhandled-rejection')).toBe(true);
    expect(runtimeEvents.some(e => e.event === 'uncaught-exception')).toBe(true);
    expect(structuredEvents.some(e => e.event === 'unhandled-rejection')).toBe(true);
    expect(structuredEvents.some(e => e.event === 'uncaught-exception')).toBe(true);
  });

  test('default logger writes formatted output to console.warn and console.error', () => {
    configureRuntimeBunLogger(null); // ensure default
    const warnLines: string[] = [];
    const errorLines: string[] = [];
    const origWarn = console.warn;
    const origError = console.error;
    console.warn = (...args: unknown[]) => warnLines.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => errorLines.push(args.map(String).join(' '));

    try {
      installProcessSafetyNet();
      process.emit('unhandledRejection', new Error('console-verify'), Promise.resolve());
      process.emit('uncaughtException', new Error('console-exc'));

      // The runtime logger should have written to console
      const allLines = [...warnLines, ...errorLines];
      expect(allLines.length).toBeGreaterThan(0);
      expect(errorLines.some(l => l.includes('console-verify'))).toBe(true);
      expect(errorLines.some(l => l.includes('console-exc'))).toBe(true);
    } finally {
      console.warn = origWarn;
      console.error = origError;
    }
  });

  test('default logger prints stack trace separately when fields contain stack', () => {
    configureRuntimeBunLogger(null); // ensure default runtime logger
    // Silence the structured logger so it doesn't write JSON to console.error
    // alongside the default runtime logger's output.
    configureRuntimeBunStructuredLogger({
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    });

    const errorLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorLines.push(args.map(String).join(' '));

    try {
      installProcessSafetyNet();
      const err = new Error('stack-test');
      process.emit('uncaughtException', err);

      // The formatted line should not contain the stack (stack is filtered out by formatLogLine)
      // The stack should be printed as a separate console.error call
      expect(errorLines.length).toBeGreaterThanOrEqual(2);
      // First line should be the formatted event line (without stack)
      expect(errorLines[0]).toContain('message=stack-test');
      expect(errorLines[0]).not.toContain('stack=');
      // One of the lines should contain the stack trace
      expect(errorLines.some(l => l.includes('Error: stack-test'))).toBe(true);
    } finally {
      console.error = origError;
    }
  });
});
