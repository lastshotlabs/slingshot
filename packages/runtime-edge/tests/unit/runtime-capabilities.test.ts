// packages/runtime-edge/tests/unit/runtime-capabilities.test.ts
//
// Tests for runtimeCapabilities() — programmatic capability reporting.
import { describe, expect, test } from 'bun:test';
import { runtimeCapabilities } from '../../src/index';

describe('runtimeCapabilities()', () => {
  test('returns a frozen object', () => {
    const caps = runtimeCapabilities();
    expect(Object.isFrozen(caps)).toBe(true);
  });

  test('reports runtime as edge', () => {
    const caps = runtimeCapabilities();
    expect(caps.runtime).toBe('edge');
  });

  test('reports filesystem capabilities correctly', () => {
    const caps = runtimeCapabilities();
    expect(caps.filesystem.read).toBe(false);
    expect(caps.filesystem.write).toBe(false);
    expect(Object.isFrozen(caps.filesystem)).toBe(true);
  });

  test('reports sqlite as unavailable', () => {
    expect(runtimeCapabilities().sqlite).toBe(false);
  });

  test('reports httpServer as unavailable', () => {
    expect(runtimeCapabilities().httpServer).toBe(false);
  });

  test('reports glob as unavailable', () => {
    expect(runtimeCapabilities().glob).toBe(false);
  });

  test('reports asyncLocalStorage as unavailable', () => {
    expect(runtimeCapabilities().asyncLocalStorage).toBe(false);
  });

  test('reports passwordHashing as webcrypto-pbkdf2', () => {
    expect(runtimeCapabilities().passwordHashing).toBe('webcrypto-pbkdf2');
  });

  test('reports abortController as available', () => {
    expect(runtimeCapabilities().abortController).toBe(true);
  });

  test('reports kvIsr as available', () => {
    expect(runtimeCapabilities().kvIsr).toBe(true);
  });

  test('reports isrCaching as available', () => {
    expect(runtimeCapabilities().isrCaching).toBe(true);
  });

  test('all boolean false fields are typed as literal false', () => {
    const caps = runtimeCapabilities();
    // TypeScript narrowing — if these are `false` (not `boolean`),
    // they should narrow correctly in conditions
    const falsyValues = [
      caps.filesystem.read,
      caps.filesystem.write,
      caps.sqlite,
      caps.httpServer,
      caps.glob,
      caps.asyncLocalStorage,
    ];
    for (const val of falsyValues) {
      expect(val).toBe(false);
      // Ensures that TypeScript sees this as `false`, not `boolean`
      if (val) {
        // This branch should be unreachable at runtime
        expect('unreachable').toBe('not reached');
      }
    }
  });

  test('returns same shape on multiple calls', () => {
    const a = runtimeCapabilities();
    const b = runtimeCapabilities();
    expect(a).toEqual(b);
  });

  test('property values are correct by exact type', () => {
    // Structural type check — verifies all known fields are present with
    // the correct literal types.
    const caps: {
      readonly runtime: 'edge';
      readonly filesystem: { readonly read: false; readonly write: false };
      readonly sqlite: false;
      readonly httpServer: false;
      readonly glob: false;
      readonly asyncLocalStorage: false;
      readonly passwordHashing: 'webcrypto-pbkdf2';
      readonly abortController: true;
      readonly kvIsr: true;
      readonly isrCaching: true;
    } = runtimeCapabilities();

    expect(caps.runtime).toBe('edge');
    expect(caps.passwordHashing).toBe('webcrypto-pbkdf2');
    expect(caps.abortController).toBe(true);
  });
});
