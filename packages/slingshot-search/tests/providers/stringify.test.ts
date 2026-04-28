import { describe, expect, test } from 'bun:test';
import { stringifyDocumentId, stringifySearchValue } from '../../src/providers/stringify';

describe('search provider stringification helpers', () => {
  test('stringifies scalar and Date values for searchable fields', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');

    expect(stringifySearchValue('ready')).toBe('ready');
    expect(stringifySearchValue(42)).toBe('42');
    expect(stringifySearchValue(false)).toBe('false');
    expect(stringifySearchValue(123n)).toBe('123');
    expect(stringifySearchValue(date)).toBe('2026-01-02T03:04:05.000Z');
  });

  test('uses fallbacks for nullish and unsafe non-data values', () => {
    expect(stringifySearchValue(null, 'fallback')).toBe('fallback');
    expect(stringifySearchValue(undefined, 'fallback')).toBe('fallback');
    expect(stringifySearchValue(Symbol('private'), 'fallback')).toBe('fallback');
    expect(stringifySearchValue(() => 'secret', 'fallback')).toBe('fallback');
  });

  test('serializes objects and falls back for circular values', () => {
    const circular: Record<string, unknown> = { id: 'doc-1' };
    circular['self'] = circular;

    expect(stringifySearchValue({ id: 'doc-1', published: true })).toBe(
      '{"id":"doc-1","published":true}',
    );
    expect(stringifySearchValue(circular, 'fallback')).toBe('fallback');
  });

  test('stringifies only stable document id primitives', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');

    expect(stringifyDocumentId('doc-1')).toBe('doc-1');
    expect(stringifyDocumentId(42)).toBe('42');
    expect(stringifyDocumentId(false)).toBe('false');
    expect(stringifyDocumentId(123n)).toBe('123');
    expect(stringifyDocumentId(date)).toBe('2026-01-02T03:04:05.000Z');
    expect(stringifyDocumentId({ id: 'doc-1' }, 'fallback')).toBe('fallback');
    expect(stringifyDocumentId(null, 'fallback')).toBe('fallback');
  });
});
