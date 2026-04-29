import { describe, expect, test } from 'bun:test';
import { bunRuntime } from '../src/index';

describe('password edge cases', () => {
  const runtime = bunRuntime({ installProcessSafetyNet: false });

  test('hash rejects empty string', async () => {
    await expect(runtime.password.hash('')).rejects.toThrow('password must not be empty');
  });

  test('hash and verify unicode password', async () => {
    const password = 'パスワード🔐🎉 защо-не? 中文密码';
    const hash = await runtime.password.hash(password);
    const result = await runtime.password.verify(password, hash);
    expect(result).toBe(true);
  });

  test('verify unicode password mismatch', async () => {
    const hash = await runtime.password.hash('パスワード🔐');
    const result = await runtime.password.verify('パスワード🔓', hash);
    expect(result).toBe(false);
  });

  test('hash and verify very long password (10KB)', async () => {
    const password = 'x'.repeat(10_000);
    const hash = await runtime.password.hash(password);
    expect(hash.length).toBeGreaterThan(0);
    const result = await runtime.password.verify(password, hash);
    expect(result).toBe(true);
  });

  test('verify very long password mismatch at end', async () => {
    const base = 'x'.repeat(9_999);
    const hash = await runtime.password.hash(base + 'a');
    const result = await runtime.password.verify(base + 'b', hash);
    expect(result).toBe(false);
  });

  test('verify with null byte in password', async () => {
    const password = 'before\x00after';
    const hash = await runtime.password.hash(password);
    const result = await runtime.password.verify(password, hash);
    expect(result).toBe(true);
  });

  test('verify with newlines in password', async () => {
    const password = 'line1\nline2\r\nline3';
    const hash = await runtime.password.hash(password);
    const result = await runtime.password.verify(password, hash);
    expect(result).toBe(true);
  });

  test('hash produces output > 20 chars (argon2id minimum)', async () => {
    const hash = await runtime.password.hash('test');
    expect(hash.length).toBeGreaterThan(20);
  });
});
