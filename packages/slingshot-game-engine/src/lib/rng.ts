/**
 * Seeded PRNG — Mulberry32 implementation.
 *
 * Provides deterministic randomness for replay. Every RNG call is
 * logged in the replay log with the seed state before/after.
 *
 * See spec §16 for the full contract.
 */
import type { SeededRng } from '../types/models';

/**
 * Mulberry32 PRNG — fast, 32-bit, deterministic.
 *
 * Returns a value in [0, 1). Advances the internal state by one step.
 */
function mulberry32(state: { value: number }): number {
  let t = (state.value += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Create a seeded RNG instance.
 *
 * The returned object satisfies the `SeededRng` interface exposed to
 * game handlers via `ctx.random`.
 *
 * @param initialSeed - The initial seed value. If 0, uses 1 instead.
 */
export function createSeededRng(
  initialSeed: number,
): SeededRng & { getState(): number; setState(s: number): void } {
  const state = { value: initialSeed || 1 };

  function next(): number {
    return mulberry32(state);
  }

  return {
    int(min: number, max: number): number {
      return Math.floor(next() * (max - min + 1)) + min;
    },

    float(min: number, max: number): number {
      return next() * (max - min) + min;
    },

    dice(count: number, sides: number): number[] {
      const results: number[] = [];
      for (let i = 0; i < count; i++) {
        results.push(Math.floor(next() * sides) + 1);
      }
      return results;
    },

    shuffle<T>(array: T[]): T[] {
      const result = [...array];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    },

    pick<T>(array: T[], count?: number): T | T[] {
      if (count === undefined) {
        return array[Math.floor(next() * array.length)];
      }
      const shuffled = this.shuffle(array);
      return shuffled.slice(0, count);
    },

    weighted<T>(items: Array<{ value: T; weight: number }>): T {
      const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
      let roll = next() * totalWeight;
      for (const item of items) {
        roll -= item.weight;
        if (roll <= 0) return item.value;
      }
      return items[items.length - 1].value;
    },

    bool(probability = 0.5): boolean {
      return next() < probability;
    },

    seed(): number {
      return state.value;
    },

    getState(): number {
      return state.value;
    },

    setState(s: number): void {
      state.value = s || 1;
    },
  };
}

/**
 * Generate a cryptographically random seed for a new session.
 */
export function generateRandomSeed(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0];
}

/**
 * Derive a seed from a session ID (for reproducible per-session randomness).
 */
export function deriveSessionSeed(sessionId: string): number {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    const char = sessionId.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash) || 1;
}
