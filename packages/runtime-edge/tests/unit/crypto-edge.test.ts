import { describe, expect, test } from 'bun:test';
import { edgeRuntime } from '../../src/index';

describe('Edge runtime — crypto operations', () => {
  test('password hash produces consistent format', async () => {
    const rt = edgeRuntime({
      hashPassword: async (pwd: string) => `pbkdf2-sha256$1000$${pwd}-hashed`,
      verifyPassword: async (pwd: string, hash: string) => hash.endsWith(`${pwd}-hashed`),
    });
    const hash = await rt.password.hash('mypassword');
    expect(hash).toContain('pbkdf2-sha256');
    expect(hash).toContain('mypassword-hashed');
  });

  test('password verify returns true for correct password', async () => {
    const rt = edgeRuntime({
      hashPassword: async (pwd: string) => `hashed:${pwd}`,
      verifyPassword: async (pwd: string, hash: string) => hash === `hashed:${pwd}`,
    });
    const valid = await rt.password.verify('correct', 'hashed:correct');
    expect(valid).toBe(true);
  });

  test('password verify returns false for wrong password', async () => {
    const rt = edgeRuntime({
      hashPassword: async (pwd: string) => `hashed:${pwd}`,
      verifyPassword: async (pwd: string, hash: string) => hash === `hashed:${pwd}`,
    });
    const valid = await rt.password.verify('wrong', 'hashed:correct');
    expect(valid).toBe(false);
  });

  test('password verify returns false for malformed hash', async () => {
    const rt = edgeRuntime({
      hashPassword: async (pwd: string) => `hashed:${pwd}`,
      verifyPassword: async (_pwd: string, _hash: string) => false,
    });
    const valid = await rt.password.verify('test', 'garbage');
    expect(valid).toBe(false);
  });

  test('mixing hashPassword without verifyPassword throws', () => {
    expect(() =>
      edgeRuntime({
        hashPassword: async (pwd: string) => pwd,
      } as any),
    ).toThrow();
  });

  test('mixing verifyPassword without hashPassword throws', () => {
    expect(() =>
      edgeRuntime({
        verifyPassword: async (_pwd: string, _hash: string) => false,
      } as any),
    ).toThrow();
  });

  test('both can be omitted (uses defaults)', () => {
    const rt = edgeRuntime({});
    expect(rt).toBeDefined();
    expect(typeof rt.password.hash).toBe('function');
    expect(typeof rt.password.verify).toBe('function');
  });
});
