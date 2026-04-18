import { describe, expect, test } from 'bun:test';
import {
  validateAttachments,
  validateBroadcastMentions,
  validateMentions,
} from '../../src/contentValidation';

describe('validateMentions', () => {
  test('returns empty frozen array for undefined', () => {
    const result = validateMentions(undefined);
    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('returns empty frozen array for non-array', () => {
    expect(validateMentions('not-array')).toEqual([]);
    expect(validateMentions(42)).toEqual([]);
  });

  test('filters non-string values', () => {
    expect(validateMentions(['user-1', 42, null, 'user-2'])).toEqual(['user-1', 'user-2']);
  });

  test('deduplicates', () => {
    expect(validateMentions(['user-1', 'user-1', 'user-2'])).toEqual(['user-1', 'user-2']);
  });

  test('caps at MAX_CONTENT_MENTIONS', () => {
    const input = Array.from({ length: 100 }, (_, i) => `user-${i}`);
    const result = validateMentions(input);
    expect(result.length).toBe(50);
  });

  test('filters empty strings', () => {
    expect(validateMentions(['', 'user-1'])).toEqual(['user-1']);
  });
});

describe('validateBroadcastMentions', () => {
  test('returns empty for undefined', () => {
    expect(validateBroadcastMentions(undefined)).toEqual([]);
  });

  test('only allows everyone and here', () => {
    expect(validateBroadcastMentions(['everyone', 'here', 'invalid'])).toEqual([
      'everyone',
      'here',
    ]);
  });

  test('deduplicates', () => {
    expect(validateBroadcastMentions(['everyone', 'everyone'])).toEqual(['everyone']);
  });
});

describe('validateAttachments', () => {
  test('returns empty for undefined', () => {
    expect(validateAttachments(undefined)).toEqual([]);
  });

  test('validates valid asset refs', () => {
    const result = validateAttachments([{ assetId: 'a1', filename: 'test.pdf' }]);
    expect(result).toHaveLength(1);
    expect(result[0].assetId).toBe('a1');
  });

  test('drops invalid entries silently', () => {
    const result = validateAttachments([
      { assetId: 'a1' },
      { invalid: true },
      { assetId: '' }, // min(1) fails
    ]);
    expect(result).toHaveLength(1);
  });

  test('caps at MAX_CONTENT_ATTACHMENTS', () => {
    const input = Array.from({ length: 20 }, (_, i) => ({ assetId: `a-${i}` }));
    const result = validateAttachments(input);
    expect(result.length).toBe(10);
  });

  test('freezes each entry', () => {
    const result = validateAttachments([{ assetId: 'a1' }]);
    expect(Object.isFrozen(result[0])).toBe(true);
  });
});
