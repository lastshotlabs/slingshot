import { describe, expect, test } from 'bun:test';
import {
  EdgeFileReadError,
  EdgeFileSizeExceededError,
  EdgePasswordConfigError,
  EdgeRuntimeError,
  EdgeUnsupportedError,
} from '../../src/errors';
import { edgeRuntime } from '../../src/index';

describe('Edge runtime — error classes', () => {
  test('EdgeRuntimeError extends Error', () => {
    const err = new EdgeRuntimeError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EdgeRuntimeError');
    expect(err.message).toContain('[runtime-edge]');
  });

  test('EdgeUnsupportedError names the feature', () => {
    const err = new EdgeUnsupportedError('glob.scan');
    expect(err.name).toBe('EdgeUnsupportedError');
    expect(err.message).toContain('glob.scan');
    expect(err.message).toContain('not available');
  });

  test('EdgeFileReadError carries file path', () => {
    const err = new EdgeFileReadError('/path/to/file', 'not found');
    expect(err.name).toBe('EdgeFileReadError');
    expect(err.filePath).toBe('/path/to/file');
    expect(err.message).toContain('/path/to/file');
    expect(err.message).toContain('not found');
  });

  test('EdgeFileSizeExceededError carries size details', () => {
    const err = new EdgeFileSizeExceededError('/big.file', 1024, 2048);
    expect(err.name).toBe('EdgeFileSizeExceededError');
    expect(err.maxBytes).toBe(1024);
    expect(err.actualBytes).toBe(2048);
    expect(err.message).toContain('2048');
    expect(err.message).toContain('1024');
  });

  test('EdgePasswordConfigError has descriptive message', () => {
    const err = new EdgePasswordConfigError();
    expect(err.name).toBe('EdgePasswordConfigError');
    expect(err.message).toContain('hashPassword');
    expect(err.message).toContain('verifyPassword');
  });

  test('all error classes are independent types', () => {
    const unsupported = new EdgeUnsupportedError('test');
    const fileRead = new EdgeFileReadError('f', 'r');
    const fileSize = new EdgeFileSizeExceededError('f', 100, 200);
    const pwdConfig = new EdgePasswordConfigError();

    expect(unsupported instanceof EdgeRuntimeError).toBe(true);
    expect(fileRead instanceof EdgeRuntimeError).toBe(true);
    expect(fileSize instanceof EdgeRuntimeError).toBe(true);
    expect(pwdConfig instanceof EdgeRuntimeError).toBe(true);

    expect(fileRead instanceof EdgeUnsupportedError).toBe(false);
    expect(unsupported instanceof EdgeFileReadError).toBe(false);
  });
});

describe('Edge runtime — unsupported feature stubs', () => {
  test('fs.write throws EdgeUnsupportedError', async () => {
    const rt = edgeRuntime({});
    await expect(rt.fs.write('/tmp/test', 'data')).rejects.toThrow(EdgeUnsupportedError);
  });

  test('glob.scan throws EdgeUnsupportedError', async () => {
    const rt = edgeRuntime({});
    await expect(rt.glob.scan('*.ts')).rejects.toThrow(EdgeUnsupportedError);
  });

  test('sqlite.open throws EdgeUnsupportedError', () => {
    const rt = edgeRuntime({});
    expect(() => rt.sqlite.open(':memory:')).toThrow(EdgeUnsupportedError);
  });

  test('server.listen throws EdgeUnsupportedError', () => {
    const rt = edgeRuntime({});
    expect(() => rt.server.listen({ port: 8080 } as any)).toThrow(EdgeUnsupportedError);
  });
});
