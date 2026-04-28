import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getAsyncLocalStorageConstructor } from '../../src/asyncLocalStorage';

// Save originals so we can restore them after each test
const originalGlobalAls = (globalThis as Record<string, unknown>).AsyncLocalStorage;
const originalGetBuiltinModule = (process as unknown as Record<string, unknown>).getBuiltinModule;

afterEach(() => {
  // Restore globalThis.AsyncLocalStorage
  if (originalGlobalAls === undefined) {
    delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
  } else {
    (globalThis as Record<string, unknown>).AsyncLocalStorage = originalGlobalAls;
  }

  // Restore process.getBuiltinModule
  if (originalGetBuiltinModule === undefined) {
    delete (process as unknown as Record<string, unknown>).getBuiltinModule;
  } else {
    (process as unknown as Record<string, unknown>).getBuiltinModule = originalGetBuiltinModule;
  }
});

describe('getAsyncLocalStorageConstructor', () => {
  it('returns globalThis.AsyncLocalStorage when it is set', () => {
    const fakeAls = class FakeAls {};
    (globalThis as Record<string, unknown>).AsyncLocalStorage = fakeAls;
    // Ensure process.getBuiltinModule won't interfere
    delete (process as unknown as Record<string, unknown>).getBuiltinModule;

    const result = getAsyncLocalStorageConstructor();
    expect(result).toBe(fakeAls as unknown as typeof result);
  });

  it('returns null when globalThis.AsyncLocalStorage is not set and process.getBuiltinModule is not defined', () => {
    delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
    delete (process as unknown as Record<string, unknown>).getBuiltinModule;

    const result = getAsyncLocalStorageConstructor();
    expect(result).toBeNull();
  });

  it('returns null when process.getBuiltinModule is defined but returns undefined for node:async_hooks', () => {
    delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
    (process as unknown as Record<string, unknown>).getBuiltinModule = (_id: string) => undefined;

    const result = getAsyncLocalStorageConstructor();
    expect(result).toBeNull();
  });

  it('returns null when the module returned by process.getBuiltinModule lacks AsyncLocalStorage', () => {
    delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
    (process as unknown as Record<string, unknown>).getBuiltinModule = (_id: string) => ({
      // a module without AsyncLocalStorage
      somethingElse: class {},
    });

    const result = getAsyncLocalStorageConstructor();
    expect(result).toBeNull();
  });

  it('returns AsyncLocalStorage from process.getBuiltinModule when it is present', () => {
    delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
    const fakeAls = class FakeAls {};
    (process as unknown as Record<string, unknown>).getBuiltinModule = (_id: string) => ({
      AsyncLocalStorage: fakeAls,
    });

    const result = getAsyncLocalStorageConstructor();
    expect(result).toBe(fakeAls as unknown as typeof result);
  });
});
