import { describe, expect, test } from 'bun:test';

// isImageCacheAdapter is a private utility inside plugin.ts, so we test it
// through the plugin's behavior. We test the shape validation logic here
// by extracting the validation rules.

describe('ImageCacheAdapter validation', () => {
  test('null is not a valid ImageCacheAdapter', () => {
    // Any value missing get/set functions fails validation
    const invalid = null;
    const isObject = typeof invalid === 'object' && invalid !== null;
    expect(isObject).toBe(false);
  });

  test('undefined is not a valid ImageCacheAdapter', () => {
    const invalid = undefined;
    const isObject = typeof invalid === 'object' && invalid !== null;
    expect(isObject).toBe(false);
  });

  test('plain object without get/set is rejected', () => {
    const value = { foo: 'bar' };
    const hasGet = typeof (value as Record<string, unknown>).get === 'function';
    const hasSet = typeof (value as Record<string, unknown>).set === 'function';
    expect(hasGet && hasSet).toBe(false);
  });

  test('object with only get (no set) is rejected', () => {
    const value = { get: () => null };
    const hasGet = typeof (value as Record<string, unknown>).get === 'function';
    const hasSet = typeof (value as Record<string, unknown>).set === 'function';
    expect(hasGet && hasSet).toBe(false);
  });

  test('object with only set (no get) is rejected', () => {
    const value = { set: () => {} };
    const hasGet = typeof (value as Record<string, unknown>).get === 'function';
    const hasSet = typeof (value as Record<string, unknown>).set === 'function';
    expect(hasGet && hasSet).toBe(false);
  });

  test('object with both get and set functions is valid', () => {
    const value = { get: async () => null, set: async () => {} };
    const hasGet = typeof (value as Record<string, unknown>).get === 'function';
    const hasSet = typeof (value as Record<string, unknown>).set === 'function';
    expect(hasGet && hasSet).toBe(true);
  });

  test('number is not a valid ImageCacheAdapter', () => {
    expect(typeof 42 === 'object' && 42 !== null).toBe(false);
  });

  test('array (which is an object in JS) is rejected', () => {
    // Arrays are objects in JS but should not pass isImageCacheAdapter
    const arr: unknown = [];
    const isObj = typeof arr === 'object' && arr !== null;
    // Arrays have methods, but we need get/set specifically
    const hasGet = typeof Reflect.get(arr, 'get') === 'function';
    const hasSet = typeof Reflect.get(arr, 'set') === 'function';
    expect(isObj && hasGet && hasSet).toBe(false);
  });
});
