/**
 * Poker blind schedule recipe.
 *
 * Utilities for managing escalating blind/ante levels based on
 * elapsed time, commonly used in poker-style games.
 *
 * See spec §23.2 for the API contract.
 */

/** A single blind level in a schedule. */
export interface BlindLevel {
  /** Small blind amount. */
  readonly smallBlind: number;
  /** Big blind amount. */
  readonly bigBlind: number;
  /** Ante amount. Default: 0. */
  readonly ante: number;
  /** Duration of this level in minutes. */
  readonly durationMinutes: number;
}

/** Result of resolving the current blind level. */
export interface CurrentBlindLevel {
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly level: number;
}

/**
 * Get the current blind level based on elapsed time.
 *
 * @param schedule - Array of blind levels in ascending order.
 * @param elapsedMinutes - Total minutes elapsed since the game started.
 * @returns The current blind level info.
 */
function getCurrentLevel(
  schedule: readonly BlindLevel[],
  elapsedMinutes: number,
): CurrentBlindLevel {
  if (schedule.length === 0) {
    return { smallBlind: 0, bigBlind: 0, ante: 0, level: 0 };
  }

  let accumulated = 0;
  for (let i = 0; i < schedule.length; i++) {
    accumulated += schedule[i].durationMinutes;
    if (elapsedMinutes < accumulated) {
      return {
        smallBlind: schedule[i].smallBlind,
        bigBlind: schedule[i].bigBlind,
        ante: schedule[i].ante,
        level: i + 1,
      };
    }
  }

  // Past all levels — use the last level
  const last = schedule[schedule.length - 1];
  return {
    smallBlind: last.smallBlind,
    bigBlind: last.bigBlind,
    ante: last.ante,
    level: schedule.length,
  };
}

/**
 * Create a standard poker blind schedule.
 *
 * Generates escalating blinds starting from `startingSmall` and
 * doubling approximately every `levelMinutes`.
 *
 * @param levels - Number of blind levels to generate.
 * @param startingSmall - Starting small blind. Default: 10.
 * @param levelMinutes - Minutes per level. Default: 15.
 */
function createSchedule(
  levels: number,
  startingSmall?: number,
  levelMinutes?: number,
): BlindLevel[] {
  const small = startingSmall ?? 10;
  const duration = levelMinutes ?? 15;
  const schedule: BlindLevel[] = [];

  for (let i = 0; i < levels; i++) {
    const multiplier = Math.pow(2, i);
    const smallBlind = small * multiplier;
    // Ante starts at level 4 at 10% of big blind
    const ante = i >= 3 ? Math.round(smallBlind * 0.2) : 0;

    schedule.push({
      smallBlind,
      bigBlind: smallBlind * 2,
      ante,
      durationMinutes: duration,
    });
  }

  return schedule;
}

export const blindSchedule = {
  getCurrentLevel,
  createSchedule,
};
