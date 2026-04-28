import { describe, expect, it } from 'bun:test';
import { computeFacets } from '../../src/providers/facets';
import {
  computeHighlights,
  computeMatchPositions,
  computeTextScore,
  highlightText,
  matchesQuery,
} from '../../src/providers/textScoring';

describe('search provider facet helpers', () => {
  it('computes distributions, numeric stats, max bucket limits, and alpha sorting', () => {
    const result = computeFacets(
      [
        { status: 'published', score: 10, author: { country: 'US' } },
        { status: 'draft', score: 5, author: { country: 'CA' } },
        { status: 'published', score: null, author: { country: 'US' } },
        { status: undefined, score: 7, author: { country: 'GB' } },
      ],
      ['status', 'score', 'author.country', 'missing'],
      {
        status: { maxValues: 1, sortBy: 'count' },
        'author.country': { sortBy: 'alpha' },
      },
    );

    expect(result.distribution.status).toEqual({ published: 2 });
    expect(result.distribution.score).toEqual({ '10': 1, '5': 1, '7': 1 });
    expect(result.distribution['author.country']).toEqual({ CA: 1, GB: 1, US: 2 });
    expect(result.distribution.missing).toEqual({});
    expect(result.stats.score).toEqual({ min: 5, max: 10, avg: 22 / 3, sum: 22, count: 3 });
    expect(result.stats.status).toBeUndefined();
  });
});

describe('search provider text scoring helpers', () => {
  const doc = {
    title: 'Alpha',
    body: 'Alphabet soup with beta',
    meta: { summary: 'Gamma beta gamma' },
    empty: null,
  };

  it('scores exact, prefix, and substring matches with field weights', () => {
    const weights = new Map([
      ['title', 3],
      ['body', 2],
    ]);

    expect(computeTextScore(doc, '', ['title'], weights)).toBe(1);
    expect(computeTextScore(doc, 'alpha soup beta', ['title', 'body', 'missing'], weights)).toBe(
      44,
    );
  });

  it('evaluates all matching strategies, including browse mode and fallback strategy', () => {
    expect(matchesQuery(doc, '', ['title'], 'all')).toBe(true);
    expect(matchesQuery(doc, 'alpha beta', ['title', 'body'], 'all')).toBe(true);
    expect(matchesQuery(doc, 'alpha missing', ['title'], 'all')).toBe(false);
    expect(matchesQuery(doc, 'alpha missing', ['title'], 'last')).toBe(true);
    expect(matchesQuery(doc, 'alpha beta missing', ['title', 'body'], 'frequency')).toBe(true);
    expect(
      matchesQuery(doc, 'alpha beta missing nope absent', ['title', 'body'], 'frequency'),
    ).toBe(false);
    expect(matchesQuery(doc, 'alpha missing', ['title'], 'unknown' as never)).toBe(false);
  });

  it('highlights regex-sensitive text and omits fields with no matches', () => {
    expect(highlightText('C++ and c?', 'c++ c?', '<mark>', '</mark>')).toBe(
      '<mark>C++</mark> and <mark>c?</mark>',
    );
    expect(highlightText('unchanged', '', '<mark>', '</mark>')).toBe('unchanged');

    expect(
      computeHighlights(doc, 'beta', ['title', 'body', 'meta.summary', 'empty'], '<em>', '</em>'),
    ).toEqual({
      body: 'Alphabet soup with <em>beta</em>',
      'meta.summary': 'Gamma <em>beta</em> gamma',
    });
  });

  it('computes sorted match positions across fields and handles empty queries', () => {
    expect(computeMatchPositions(doc, '', ['title'])).toEqual({});
    expect(computeMatchPositions(doc, 'beta gamma', ['body', 'meta.summary', 'missing'])).toEqual({
      body: [{ start: 19, length: 4 }],
      'meta.summary': [
        { start: 0, length: 5 },
        { start: 6, length: 4 },
        { start: 11, length: 5 },
      ],
    });
  });
});
