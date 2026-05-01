import { describe, expect, test } from 'bun:test';
import { runtimeCapabilities } from '../src/index';

describe('runtimeCapabilities', () => {
  test('returns a frozen object', () => {
    const caps = runtimeCapabilities();
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.filesystem)).toBe(true);
  });

  test('reports runtime identifier as bun', () => {
    const caps = runtimeCapabilities();
    expect(caps.runtime).toBe('bun');
  });

  test('reports all filesystem capabilities as true', () => {
    const caps = runtimeCapabilities();
    expect(caps.filesystem.read).toBe(true);
    expect(caps.filesystem.write).toBe(true);
  });

  test('reports sqlite as true', () => {
    expect(runtimeCapabilities().sqlite).toBe(true);
  });

  test('reports httpServer as true', () => {
    expect(runtimeCapabilities().httpServer).toBe(true);
  });

  test('reports glob as true', () => {
    expect(runtimeCapabilities().glob).toBe(true);
  });

  test('reports asyncLocalStorage as true', () => {
    expect(runtimeCapabilities().asyncLocalStorage).toBe(true);
  });

  test('reports passwordHashing as bun-argon2', () => {
    expect(runtimeCapabilities().passwordHashing).toBe('bun-argon2');
  });

  test('reports webSocket as true', () => {
    expect(runtimeCapabilities().webSocket).toBe(true);
  });

  test('all capabilities are true except runtime and passwordHashing', () => {
    const caps = runtimeCapabilities();
    const keys = Object.keys(caps) as Array<keyof typeof caps>;
    for (const key of keys) {
      if (key === 'runtime') {
        expect(caps[key]).toBe('bun');
      } else if (key === 'passwordHashing') {
        expect(caps[key]).toBe('bun-argon2');
      } else if (key === 'filesystem') {
        const fs = caps[key];
        expect(fs.read).toBe(true);
        expect(fs.write).toBe(true);
      } else {
        expect(caps[key]).toBe(true);
      }
    }
  });

  test('successive calls return independent frozen objects', () => {
    const a = runtimeCapabilities();
    const b = runtimeCapabilities();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  test('attempting to modify a frozen capability throws in strict mode', () => {
    const caps = runtimeCapabilities();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (caps as any).sqlite = false;
    }).toThrow();
  });
});
