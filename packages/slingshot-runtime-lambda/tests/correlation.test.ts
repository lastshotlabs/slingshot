import { describe, expect, test } from 'bun:test';
import {
  decodeBase64JsonOrText,
  decodeHttpBody,
  decodeMaybeJson,
  firstString,
  readHeader,
} from '../src/correlation';

describe('correlation helpers', () => {
  test('firstString returns the first non-empty string', () => {
    expect(firstString(undefined, '', 'corr-1', 'corr-2')).toBe('corr-1');
    expect(firstString(undefined, '', null)).toBeNull();
  });

  test('readHeader matches header names case-insensitively', () => {
    expect(
      readHeader(
        {
          'X-Correlation-Id': 'corr-1',
        },
        'x-correlation-id',
      ),
    ).toBe('corr-1');
  });

  test('decodeMaybeJson parses JSON strings and leaves text untouched', () => {
    expect(decodeMaybeJson('{"ok":true}')).toEqual({ ok: true });
    expect(decodeMaybeJson('plain-text')).toBe('plain-text');
  });

  test('decodeBase64JsonOrText parses base64-encoded JSON and text payloads', () => {
    expect(decodeBase64JsonOrText(Buffer.from('{"ok":true}').toString('base64'))).toEqual({
      ok: true,
    });
    expect(decodeBase64JsonOrText(Buffer.from('hello').toString('base64'))).toBe('hello');
  });

  test('decodeHttpBody handles empty, plain, and base64 payloads', () => {
    expect(decodeHttpBody(undefined)).toEqual({});
    expect(decodeHttpBody('{"ok":true}')).toEqual({ ok: true });
    expect(decodeHttpBody(Buffer.from('{"ok":true}').toString('base64'), true)).toEqual({
      ok: true,
    });
  });
});
