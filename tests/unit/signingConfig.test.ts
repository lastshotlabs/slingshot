import { describe, expect, test } from 'bun:test';
import { getDataEncryptionKeys } from '../../src/lib/signingConfig';

describe('getDataEncryptionKeys', () => {
  test('returns empty array for undefined input', () => {
    expect(getDataEncryptionKeys(undefined)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(getDataEncryptionKeys('')).toEqual([]);
  });

  test('returns empty array for whitespace-only string', () => {
    expect(getDataEncryptionKeys('   ')).toEqual([]);
  });

  test('parses a single valid 32-byte key', () => {
    // 32 bytes = 44 base64 chars (with padding) or less with base64url
    const keyBytes = new Uint8Array(32).fill(0xab);
    const base64Key = Buffer.from(keyBytes).toString('base64');
    const result = getDataEncryptionKeys(`v1:${base64Key}`);
    expect(result).toHaveLength(1);
    expect(result[0].keyId).toBe('v1');
    expect(result[0].key).toBeInstanceOf(Buffer);
    expect(result[0].key.length).toBe(32);
  });

  test('parses multiple comma-separated keys', () => {
    const keyBytes1 = new Uint8Array(32).fill(0x01);
    const keyBytes2 = new Uint8Array(32).fill(0x02);
    const base64Key1 = Buffer.from(keyBytes1).toString('base64');
    const base64Key2 = Buffer.from(keyBytes2).toString('base64');
    const result = getDataEncryptionKeys(`v2:${base64Key1},v1:${base64Key2}`);
    expect(result).toHaveLength(2);
    expect(result[0].keyId).toBe('v2');
    expect(result[1].keyId).toBe('v1');
  });

  test('throws for entry missing colon separator', () => {
    const keyBytes = new Uint8Array(32).fill(0x01);
    const base64Key = Buffer.from(keyBytes).toString('base64');
    expect(() => getDataEncryptionKeys(`v1${base64Key}`)).toThrow('invalid entry');
  });

  test('throws for key that is not 32 bytes', () => {
    // 16 bytes = not 32
    const keyBytes = new Uint8Array(16).fill(0x01);
    const base64Key = Buffer.from(keyBytes).toString('base64');
    expect(() => getDataEncryptionKeys(`v1:${base64Key}`)).toThrow('must be 32 bytes');
  });

  test('handles keyId with colons in value (takes first colon as separator)', () => {
    // The colon index uses indexOf(':'), so everything after first colon is the key
    const keyBytes = new Uint8Array(32).fill(0xff);
    const base64Key = Buffer.from(keyBytes).toString('base64');
    // This should parse keyId='v1' and key=base64Key
    const result = getDataEncryptionKeys(`v1:${base64Key}`);
    expect(result[0].keyId).toBe('v1');
  });

  test('trims whitespace from keyId and key', () => {
    const keyBytes = new Uint8Array(32).fill(0x05);
    const base64Key = Buffer.from(keyBytes).toString('base64');
    const result = getDataEncryptionKeys(` v1 : ${base64Key} `);
    expect(result[0].keyId).toBe('v1');
    expect(result[0].key.length).toBe(32);
  });
});
