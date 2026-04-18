/**
 * Recipes — composable game utilities.
 *
 * Reusable building blocks that game developers import and compose
 * to reduce boilerplate for common patterns.
 *
 * @example
 * ```ts
 * import { standardDeck, gridBoard, elimination } from 'slingshot-game-engine/recipes';
 * ```
 */

export { standardDeck } from './standardDeck';
export type {
  Card,
  JokerCard,
  DeckCard,
  Suit,
  Rank,
  PokerHandResult,
  CreateDeckOptions,
} from './standardDeck';

export { gridBoard } from './gridBoard';
export type {
  Grid,
  Position,
  CreateGridOptions,
  NeighborOptions,
  PathOptions,
  FloodFillOptions,
} from './gridBoard';

export { elimination } from './elimination';
export type { EliminateLowestOptions, EliminateBelowOptions } from './elimination';

export { blindSchedule } from './blindSchedule';
export type { BlindLevel, CurrentBlindLevel } from './blindSchedule';

export { wordValidator } from './wordValidator';
export type { FuzzyMatchResult } from './wordValidator';
