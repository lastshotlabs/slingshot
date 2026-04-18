import { describe, expect, test } from 'bun:test';
import { computeNetScore } from '../../../src/lib/scoring';

const w1 = { upvoteWeight: 1, downvoteWeight: 1, emojiWeights: {} };
describe('computeNetScore', () => {
  test('zero reactions → 0', () => {
    expect(computeNetScore(0, 0, {}, w1)).toBe(0);
  });
  test('upvotes only → positive score', () => {
    expect(computeNetScore(5, 0, {}, w1)).toBe(5);
  });
  test('downvotes only → negative score', () => {
    expect(computeNetScore(0, 3, {}, w1)).toBe(-3);
  });
  test('upvotes and downvotes → net difference', () => {
    expect(computeNetScore(10, 4, {}, w1)).toBe(6);
  });
  test('emoji bonus is added', () => {
    const scoring = { upvoteWeight: 1, downvoteWeight: 1, emojiWeights: { heart: 2 } };
    expect(computeNetScore(3, 0, { heart: 4 }, scoring)).toBe(11);
  });
  test('unknown emoji shortcode contributes 0', () => {
    const scoring = { upvoteWeight: 1, downvoteWeight: 1, emojiWeights: { heart: 2 } };
    expect(computeNetScore(0, 0, { fire: 10 }, scoring)).toBe(0);
  });
  test('custom upvoteWeight is applied', () => {
    const scoring = { upvoteWeight: 2, downvoteWeight: 1, emojiWeights: {} };
    expect(computeNetScore(5, 1, {}, scoring)).toBe(9);
  });
  test('custom downvoteWeight is applied', () => {
    const scoring = { upvoteWeight: 1, downvoteWeight: 3, emojiWeights: {} };
    expect(computeNetScore(2, 2, {}, scoring)).toBe(-4);
  });
  test('multiple emoji types are summed', () => {
    const scoring = { upvoteWeight: 1, downvoteWeight: 1, emojiWeights: { heart: 1, fire: 2 } };
    expect(computeNetScore(0, 0, { heart: 3, fire: 2 }, scoring)).toBe(7);
  });
  test('fractional weights are handled', () => {
    const scoring = { upvoteWeight: 0.5, downvoteWeight: 0.5, emojiWeights: {} };
    expect(computeNetScore(4, 2, {}, scoring)).toBeCloseTo(1);
  });
});
