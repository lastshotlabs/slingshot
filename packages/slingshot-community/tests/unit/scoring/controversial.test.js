import { describe, expect, test } from 'bun:test';
import { computeControversialScore } from '../../../src/lib/scoring';

describe('computeControversialScore', () => {
  test('equal upvotes and downvotes → maximum controversy', () => {
    // net = 0, so max(|0|,1) = 1; score = 100/1 = 100
    const score = computeControversialScore(50, 50, 0);
    expect(score).toBe(100);
  });
  test('pure upvotes → low controversy', () => {
    // net = 100, upvotes + downvotes = 100; score = 100/100 = 1
    const score = computeControversialScore(100, 0, 100);
    expect(score).toBe(1);
  });
  test('pure downvotes → low controversy', () => {
    // net = -50, |net| = 50; score = 50/50 = 1
    const score = computeControversialScore(0, 50, -50);
    expect(score).toBe(1);
  });
  test('zero reactions → 0', () => {
    const score = computeControversialScore(0, 0, 0);
    expect(score).toBe(0);
  });
  test('small net with high engagement → high score', () => {
    // 99 upvotes, 100 downvotes, net = -1; score = 199/1 = 199
    const score = computeControversialScore(99, 100, -1);
    expect(score).toBe(199);
  });
  test('|net| never less than 1 in denominator', () => {
    expect(() => computeControversialScore(5, 5, 0)).not.toThrow();
  });
  test('net with emoji weight offset → denominator uses |net|', () => {
    // net = 3 (e.g. from emoji bonus), upvotes+downvotes = 10
    const score = computeControversialScore(5, 5, 3);
    expect(score).toBeCloseTo(10 / 3);
  });
});
