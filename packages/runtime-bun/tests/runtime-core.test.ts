import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { bunRuntime, resetProcessSafetyNetForTest } from '../src/index';

describe('runtime-core', () => {
  beforeEach(() => {
    resetProcessSafetyNetForTest();
  });

  afterEach(() => {
    resetProcessSafetyNetForTest();
  });

  test('returns an object with all required SlingshotRuntime properties', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const keys = Object.keys(runtime);
    expect(keys).toContain('password');
    expect(keys).toContain('sqlite');
    expect(keys).toContain('server');
    expect(keys).toContain('fs');
    expect(keys).toContain('glob');
    expect(keys).toContain('readFile');
    expect(keys).toContain('supportsAsyncLocalStorage');
  });

  test('supportsAsyncLocalStorage is true', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    expect(runtime.supportsAsyncLocalStorage).toBe(true);
  });

  test('all capability sub-object methods are functions', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    expect(typeof runtime.password.hash).toBe('function');
    expect(typeof runtime.password.verify).toBe('function');
    expect(typeof runtime.sqlite.open).toBe('function');
    expect(typeof runtime.server.listen).toBe('function');
    expect(typeof runtime.fs.write).toBe('function');
    expect(typeof runtime.fs.readFile).toBe('function');
    expect(typeof runtime.fs.exists).toBe('function');
    expect(typeof runtime.glob.scan).toBe('function');
    expect(typeof runtime.readFile).toBe('function');
  });

  test('installProcessSafetyNet is active by default', () => {
    resetProcessSafetyNetForTest();
    const beforeUnhandled = process.listenerCount('unhandledRejection');
    const beforeUncaught = process.listenerCount('uncaughtException');
    bunRuntime();
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled + 1);
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1);
  });

  test('installProcessSafetyNet: false prevents handler registration', () => {
    resetProcessSafetyNetForTest();
    const beforeUnhandled = process.listenerCount('unhandledRejection');
    const beforeUncaught = process.listenerCount('uncaughtException');
    bunRuntime({ installProcessSafetyNet: false });
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled);
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught);
  });

  test('multiple bunRuntime() calls with default options do not register duplicate process handlers', () => {
    resetProcessSafetyNetForTest();
    bunRuntime();
    const afterFirst = process.listenerCount('unhandledRejection');
    bunRuntime();
    expect(process.listenerCount('unhandledRejection')).toBe(afterFirst);
  });

  test('runtime object is extensible (not frozen)', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    expect(Object.isExtensible(runtime)).toBe(true);
    expect(Object.isExtensible(runtime.password)).toBe(true);
    expect(Object.isExtensible(runtime.sqlite)).toBe(true);
    expect(Object.isExtensible(runtime.server)).toBe(true);
    expect(Object.isExtensible(runtime.fs)).toBe(true);
    expect(Object.isExtensible(runtime.glob)).toBe(true);
  });

  test('explicit option values override defaults for process safety net', () => {
    resetProcessSafetyNetForTest();
    const beforeUnhandled = process.listenerCount('unhandledRejection');
    bunRuntime({ installProcessSafetyNet: true });
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled + 1);
    resetProcessSafetyNetForTest();
    const beforeUnhandledAfterReset = process.listenerCount('unhandledRejection');
    bunRuntime({ installProcessSafetyNet: false });
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandledAfterReset);
  });
});
