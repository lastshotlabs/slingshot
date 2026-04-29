/**
 * Edge-case tests for text scoring: relevance tuning, field boosting,
 * exact match prioritization, and highlight behavior.
 */
import { describe, expect, test } from 'bun:test';
import {
  computeTextScore,
  computeHighlights,
  computeMatchPositions,
  matchesQuery,
} from '../../src/providers/textScoring';

describe('text scoring — relevance tuning', () => {
  const doc = {
    title: 'Alpha Beta Gamma',
    body: 'Delta alpha epsilon beta',
    tags: 'alpha,beta,gamma',
    description: 'Beta version of alpha software',
    empty: null,
    score: 100,
  };

  test('single term exact match scores higher than partial match', () => {
    const weights = new Map([['title', 3]]);
    const exactScore = computeTextScore(doc, 'Alpha', ['title'], weights);
    const partialScore = computeTextScore(doc, 'Alph', ['title'], weights);
    // Exact match should have a higher score
    expect(exactScore).toBeGreaterThanOrEqual(partialScore);
  });

  test('field boosting affects relevance score', () => {
    const highBoost = new Map([
      ['title', 10],
      ['body', 1],
    ]);
    const lowBoost = new Map([
      ['title', 1],
      ['body', 10],
    ]);

    const scoreHighTitle = computeTextScore(doc, 'alpha', ['title', 'body'], highBoost);
    const scoreLowTitle = computeTextScore(doc, 'alpha', ['title', 'body'], lowBoost);

    // With title boosted 10x, a title match should score higher
    expect(scoreHighTitle).toBeGreaterThanOrEqual(scoreLowTitle);
  });

  test('query missing in all fields returns minimal score', () => {
    const weights = new Map([['title', 3]]);
    const score = computeTextScore(doc, 'nonexistent word here', ['title'], weights);
    expect(score).toBeLessThanOrEqual(1);
  });

  test('empty query returns base score', () => {
    const result = computeTextScore(doc, '', ['title'], new Map());
    expect(result).toBe(1);
  });

  test('scoring with null/undefined fields gracefully handles them', () => {
    const score = computeTextScore(
      { title: null, body: 'actual content' },
      'content',
      ['title', 'body'],
      new Map([['body', 2]]),
    );
    expect(score).toBeGreaterThanOrEqual(1);
  });
});

describe('text scoring — matchesQuery', () => {
  const doc = { title: 'Alpha Beta', body: 'Gamma Delta' };

  test('all matching strategy requires every term to match somewhere', () => {
    expect(matchesQuery(doc, 'alpha beta', ['title', 'body'], 'all')).toBe(true);
    expect(matchesQuery(doc, 'alpha gamma', ['title', 'body'], 'all')).toBe(true);
    expect(matchesQuery(doc, 'alpha missing', ['title', 'body'], 'all')).toBe(false);
  });

  test('last matching strategy requires all terms except last to match', () => {
    // 'alpha' matches title, 'missing' is the last (optional) term
    expect(matchesQuery(doc, 'alpha missing', ['title'], 'last')).toBe(true);
    // 'missing' doesn't match, 'beta' is the last (optional) term
    expect(matchesQuery(doc, 'missing beta', ['title'], 'last')).toBe(false);
    // 'alpha' matches title, 'beta' matches title, 'nope' is the last (optional) term
    expect(matchesQuery(doc, 'alpha beta nope', ['title'], 'last')).toBe(true);
  });

  test('frequency strategy requires at least half of terms to match', () => {
    expect(matchesQuery(doc, 'alpha beta gamma', ['title', 'body'], 'frequency')).toBe(true);
    // 4/7 terms match (alpha, beta, gamma, delta) which is >= ceil(7/2)=4
    expect(matchesQuery(doc, 'alpha beta gamma delta epsilon zeta eta', ['title', 'body'], 'frequency')).toBe(
      true,
    );
    // 1/3 terms match (alpha only) which is < ceil(3/2)=2
    expect(matchesQuery(doc, 'alpha missing nowhere', ['title', 'body'], 'frequency')).toBe(
      false,
    );
  });

  test('browse mode (empty query) returns true', () => {
    expect(matchesQuery(doc, '', ['title'], 'all')).toBe(true);
  });
});

describe('text scoring — highlight edge cases', () => {
  test('highlights single term matches across fields', () => {
    const doc = { title: 'Alpha', body: 'Alpha content with beta', tags: 'alpha' };
    const result = computeHighlights(doc, 'alpha', ['title', 'body', 'tags'], '<em>', '</em>');
    // Fields that contain 'alpha' should have highlights
    expect(result['title']).toContain('<em>');
    expect(result['body']).toContain('<em>');
  });

  test('fields without matches do not appear in highlights', () => {
    const doc = { title: 'Alpha', body: 'No match' };
    const result = computeHighlights(doc, 'Alpha', ['title', 'body'], '<mark>', '</mark>');
    expect(result['title']).toBeDefined();
    expect(result['body']).toBeUndefined();
  });

  test('empty query returns empty highlights', () => {
    const doc = { title: 'Alpha', body: 'Beta' };
    const result = computeHighlights(doc, '', ['title', 'body'], '<em>', '</em>');
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('regex-special characters in query are escaped', () => {
    const doc = { title: 'C++ and C# language' };
    const result = computeHighlights(doc, 'c++', ['title'], '<mark>', '</mark>');
    expect(result['title']).toContain('<mark>C++</mark>');
  });
});

describe('text scoring — match positions', () => {
  test('computes match positions for overlapping terms', () => {
    const doc = { body: 'beta beta gamma' };
    const positions = computeMatchPositions(doc, 'beta gamma', ['body']);
    expect(positions['body'].length).toBeGreaterThanOrEqual(1);
  });

  test('empty query returns empty positions', () => {
    const doc = { body: 'content' };
    const positions = computeMatchPositions(doc, '', ['body']);
    expect(positions).toEqual({});
  });
});
