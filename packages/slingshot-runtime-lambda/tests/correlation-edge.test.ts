import { describe, expect, test } from 'bun:test';
import {
  decodeBase64JsonOrText,
  decodeHttpBody,
  decodeMaybeJson,
  firstString,
  readHeader,
} from '../src/correlation';

describe('firstString', () => {
  test('returns first non-empty string', () => {
    expect(firstString('a', 'b')).toBe('a');
  });

  test('skips empty strings', () => {
    expect(firstString('', 'b')).toBe('b');
  });

  test('skips non-strings', () => {
    expect(firstString(null, undefined, 123, 'found')).toBe('found');
  });

  test('returns null when no string found', () => {
    expect(firstString(null, undefined, 123, true)).toBeNull();
  });

  test('returns null for empty input', () => {
    expect(firstString()).toBeNull();
  });
});

describe('readHeader', () => {
  test('reads header case-insensitively', () => {
    expect(readHeader({ 'Content-Type': 'application/json' }, 'content-type')).toBe(
      'application/json',
    );
  });

  test('returns null for missing header', () => {
    expect(readHeader({ 'X-Foo': 'bar' }, 'x-baz')).toBeNull();
  });

  test('returns null for undefined headers', () => {
    expect(readHeader(undefined, 'any')).toBeNull();
  });

  test('returns null for empty header value', () => {
    expect(readHeader({ 'X-Empty': '' }, 'x-empty')).toBeNull();
  });

  test('handles mixed case headers', () => {
    expect(readHeader({ 'X-Custom-Header': 'value' }, 'x-custom-header')).toBe('value');
  });
});

describe('decodeMaybeJson', () => {
  test('parses valid JSON', () => {
    expect(decodeMaybeJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('returns string for invalid JSON', () => {
    expect(decodeMaybeJson('not-json')).toBe('not-json');
  });

  test('returns non-string values as-is', () => {
    expect(decodeMaybeJson(42)).toBe(42);
    expect(decodeMaybeJson(null)).toBeNull();
    expect(decodeMaybeJson(true)).toBe(true);
  });

  test('parses JSON arrays', () => {
    expect(decodeMaybeJson('[1,2,3]')).toEqual([1, 2, 3]);
  });
});

describe('decodeBase64JsonOrText', () => {
  test('decodes base64 JSON', () => {
    const encoded = Buffer.from('{"x":1}').toString('base64');
    expect(decodeBase64JsonOrText(encoded)).toEqual({ x: 1 });
  });

  test('handles non-base64 strings gracefully', () => {
    const result = decodeBase64JsonOrText('!!!not-base64!!!');
    // Either returns the original value (if decode fails) or decodes to something (base64 is lenient)
    expect(typeof result).toBe('string');
  });

  test('decodes base64 plain text', () => {
    const encoded = Buffer.from('hello world').toString('base64');
    expect(decodeBase64JsonOrText(encoded)).toBe('hello world');
  });
});

describe('decodeHttpBody', () => {
  test('returns empty object for null/undefined body', () => {
    expect(decodeHttpBody(null)).toEqual({});
    expect(decodeHttpBody(undefined)).toEqual({});
  });

  test('parses JSON body', () => {
    expect(decodeHttpBody('{"key":"val"}')).toEqual({ key: 'val' });
  });

  test('handles base64-encoded body', () => {
    const encoded = Buffer.from('{"encoded":true}').toString('base64');
    expect(decodeHttpBody(encoded, true)).toEqual({ encoded: true });
  });

  test('returns non-JSON string as-is for non-base64', () => {
    expect(decodeHttpBody('plain text')).toBe('plain text');
  });
});
