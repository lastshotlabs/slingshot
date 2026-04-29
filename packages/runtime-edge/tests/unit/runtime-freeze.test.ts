import { describe, expect, test } from 'bun:test';
import { edgeRuntime } from '../../src/index';

describe('Edge runtime — frozen surface', () => {
  test('returned runtime is frozen', () => {
    const rt = edgeRuntime({});
    expect(Object.isFrozen(rt)).toBe(true);
  });

  test('all sub-objects are frozen', () => {
    const rt = edgeRuntime({});
    expect(Object.isFrozen(rt.password)).toBe(true);
    expect(Object.isFrozen(rt.fs)).toBe(true);
    expect(Object.isFrozen(rt.glob)).toBe(true);
    expect(Object.isFrozen(rt.sqlite)).toBe(true);
    expect(Object.isFrozen(rt.server)).toBe(true);
  });

  test('cannot add properties to runtime', () => {
    const rt = edgeRuntime({});
    expect(() => {
      (rt as any).newProp = 'test';
    }).toThrow();
  });

  test('cannot delete properties from runtime', () => {
    const rt = edgeRuntime({});
    expect(() => {
      delete (rt as any).password;
    }).toThrow();
  });

  test('supportsAsyncLocalStorage is false', () => {
    const rt = edgeRuntime({});
    expect(rt.supportsAsyncLocalStorage).toBe(false);
  });

  test('fileStore option creates fs with read capability', () => {
    const rt = edgeRuntime({
      async fileStore(path: string) {
        return path ? 'test' : null;
      },
    });
    expect(typeof rt.fs.readFile).toBe('function');
  });

  test('without fileStore, fs operations return null or throw', () => {
    const rt = edgeRuntime({});
    expect(rt.fs.exists('any')).resolves.toBe(false);
  });
});
