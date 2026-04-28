import { describe, expect, test } from 'bun:test';
import { generateJoinCode } from '../../src/middleware/sessionCreateGuard';

const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

describe('generateJoinCode', () => {
  test('returns a string of the requested length', () => {
    expect(generateJoinCode(4).length).toBe(4);
    expect(generateJoinCode(8).length).toBe(8);
  });

  test('only uses characters from the join code alphabet', () => {
    const code = generateJoinCode(200);
    for (const ch of code) {
      expect(JOIN_CODE_ALPHABET).toContain(ch);
    }
  });

  test('excludes ambiguous characters I, O, 0, 1', () => {
    const code = generateJoinCode(1000);
    expect(code).not.toMatch(/[IO01]/);
  });

  test('1000 calls of an 8-char code produce unique outputs and run in <100ms', () => {
    const start = performance.now();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const code = generateJoinCode(8);
      expect(code.length).toBe(8);
      for (const ch of code) {
        expect(JOIN_CODE_ALPHABET).toContain(ch);
      }
      seen.add(code);
    }
    const elapsed = performance.now() - start;
    // 32^8 ≈ 1.1e12 combinations; collisions in 1000 draws are vanishingly unlikely.
    expect(seen.size).toBe(1000);
    expect(elapsed).toBeLessThan(100);
  });

  test('distributes characters roughly uniformly across the alphabet', () => {
    // 32-char alphabet, draw 32000 chars → expect ~1000 of each.
    const code = generateJoinCode(32000);
    const counts = new Map<string, number>();
    for (const ch of code) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    for (const ch of JOIN_CODE_ALPHABET) {
      const c = counts.get(ch) ?? 0;
      expect(c).toBeGreaterThan(700);
      expect(c).toBeLessThan(1300);
    }
  });
});
