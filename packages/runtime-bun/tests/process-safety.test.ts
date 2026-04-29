import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Logger } from '@lastshotlabs/slingshot-core';
import {
  configureRuntimeBunLogger,
  configureRuntimeBunStructuredLogger,
  installProcessSafetyNet,
  resetProcessSafetyNetForTest,
} from '../src/index';
import type { RuntimeBunLogger } from '../src/index';

describe('process-safety', () => {
  beforeEach(() => {
    resetProcessSafetyNetForTest();
  });

  afterEach(() => {
    resetProcessSafetyNetForTest();
    configureRuntimeBunLogger(null);
    configureRuntimeBunStructuredLogger(null);
  });

  test('registers exactly one handler per process event', () => {
    installProcessSafetyNet();
    expect(process.listenerCount('unhandledRejection')).toBe(1);
    expect(process.listenerCount('uncaughtException')).toBe(1);
  });

  test('idempotent - second call does not add duplicate listeners', () => {
    installProcessSafetyNet();
    const afterFirst = process.listenerCount('unhandledRejection');
    installProcessSafetyNet();
    expect(process.listenerCount('unhandledRejection')).toBe(afterFirst);
    expect(process.listenerCount('uncaughtException')).toBe(afterFirst);
  });

  test('unhandledRejection with Error reason is handled without throwing', () => {
    installProcessSafetyNet();
    expect(() => {
      process.emit('unhandledRejection', new Error('test-rejection'), Promise.resolve());
    }).not.toThrow();
  });

  test('unhandledRejection with string reason is handled without throwing', () => {
    installProcessSafetyNet();
    expect(() => {
      process.emit('unhandledRejection', 'string-reason', Promise.resolve());
    }).not.toThrow();
  });

  test('unhandledRejection with null reason is handled without throwing', () => {
    installProcessSafetyNet();
    expect(() => {
      process.emit('unhandledRejection', null, Promise.resolve());
    }).not.toThrow();
  });

  test('unhandledRejection with undefined reason is handled without throwing', () => {
    installProcessSafetyNet();
    expect(() => {
      process.emit('unhandledRejection', undefined, Promise.resolve());
    }).not.toThrow();
  });

  test('uncaughtException handler is invoked without throwing', () => {
    installProcessSafetyNet();
    expect(() => {
      process.emit('uncaughtException', new Error('test-exception'));
    }).not.toThrow();
  });

  test('resetProcessSafetyNetForTest removes all registered handlers', () => {
    installProcessSafetyNet();
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(0);
    expect(process.listenerCount('uncaughtException')).toBeGreaterThan(0);

    resetProcessSafetyNetForTest();
    expect(process.listenerCount('unhandledRejection')).toBe(0);
    expect(process.listenerCount('uncaughtException')).toBe(0);
  });

  test('after reset, re-installation re-registers handlers exactly once', () => {
    installProcessSafetyNet();
    resetProcessSafetyNetForTest();
    installProcessSafetyNet();
    expect(process.listenerCount('unhandledRejection')).toBe(1);
    expect(process.listenerCount('uncaughtException')).toBe(1);
  });

  test('structured logger receives message and stack fields for Error reasons', () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const custom: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(event: string, fields: Record<string, unknown>) {
        events.push({ event, fields });
      },
      child() {
        return custom;
      },
    };
    configureRuntimeBunStructuredLogger(custom);
    installProcessSafetyNet();

    const err = new Error('with-stack');
    process.emit('unhandledRejection', err, Promise.resolve());

    expect(events.length).toBeGreaterThan(0);
    const rejectionEvent = events.find(e => e.event === 'unhandled-rejection');
    expect(rejectionEvent).toBeDefined();
    expect(rejectionEvent!.fields?.message).toBe('with-stack');
    expect(rejectionEvent!.fields?.stack).toBeTypeOf('string');
  });

  test('structured logger receives correct fields for string rejections', () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const custom: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(event: string, fields: Record<string, unknown>) {
        events.push({ event, fields });
      },
      child() {
        return custom;
      },
    };
    configureRuntimeBunStructuredLogger(custom);
    installProcessSafetyNet();

    process.emit('unhandledRejection', 'plain-string', Promise.resolve());

    const rejectionEvent = events.find(e => e.event === 'unhandled-rejection');
    expect(rejectionEvent).toBeDefined();
    expect(rejectionEvent!.fields?.message).toBe('plain-string');
    expect(rejectionEvent!.fields?.stack).toBeUndefined();
  });

  test('runtime logger receives same events as structured logger', () => {
    const runtimeEvents: Array<{ event: string }> = [];
    const structuredEvents: Array<{ event: string }> = [];
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

    process.emit('unhandledRejection', new Error('sync-test'), Promise.resolve());
    process.emit('uncaughtException', new Error('sync-test-exc'));

    // Both loggers should have received both events
    expect(runtimeEvents.filter(e => e.event === 'unhandled-rejection').length).toBe(1);
    expect(runtimeEvents.filter(e => e.event === 'uncaught-exception').length).toBe(1);
    expect(structuredEvents.filter(e => e.event === 'unhandled-rejection').length).toBe(1);
    expect(structuredEvents.filter(e => e.event === 'uncaught-exception').length).toBe(1);
  });
});
