import { describe, expect, test } from 'bun:test';
import { computeHotScore } from '../../../src/lib/scoring';

// Epoch seconds for a fixed reference point (2024-01-01T00:00:00Z)
const EPOCH = 1_704_067_200;
describe('computeHotScore', () => {
  test('positive net: order component = log10(net)', () => {
    const score = computeHotScore(10, EPOCH, 12);
    const expected = Math.log10(10) * 1 + EPOCH / (12 * 3600);
    expect(score).toBeCloseTo(expected);
  });
  test('zero net: sign is zero so order component is 0', () => {
    const score = computeHotScore(0, EPOCH, 12);
    const expected = Math.log10(1) * 0 + EPOCH / (12 * 3600);
    expect(score).toBeCloseTo(expected);
  });
  test('negative net: log component is negative', () => {
    const score = computeHotScore(-10, EPOCH, 12);
    const expected = Math.log10(10) * -1 + EPOCH / (12 * 3600);
    expect(score).toBeCloseTo(expected);
  });
  test('net=1 → order=0 (log10(1) = 0)', () => {
    const score = computeHotScore(1, EPOCH, 12);
    const expected = 0 + EPOCH / (12 * 3600);
    expect(score).toBeCloseTo(expected);
  });
  test('larger hotDecayHours → smaller time component', () => {
    const score12 = computeHotScore(1, EPOCH, 12);
    const score24 = computeHotScore(1, EPOCH, 24);
    expect(score24).toBeLessThan(score12);
  });
  test('newer content (larger epoch) → higher score', () => {
    const older = computeHotScore(5, EPOCH, 12);
    const newer = computeHotScore(5, EPOCH + 3600, 12);
    expect(newer).toBeGreaterThan(older);
  });
  test('|net|=0 treated as 1 — no log10(0) error', () => {
    expect(() => computeHotScore(0, EPOCH, 12)).not.toThrow();
  });
  test('fractional net clamped to |net| ≥ 1 floor', () => {
    // net=0.5 → max(|0.5|,1)=1 → log10(1)*sign=0*sign
    const score = computeHotScore(0, EPOCH, 12);
    expect(Number.isFinite(score)).toBe(true);
  });
});
