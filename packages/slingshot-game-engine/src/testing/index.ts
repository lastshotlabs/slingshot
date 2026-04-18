/**
 * Testing utilities for `slingshot-game-engine`.
 *
 * Provides a self-contained test harness, simulated players,
 * deterministic time control, and game-specific assertions.
 *
 * @example
 * ```ts
 * import { createTestHarness, SimulatedPlayer, gameAssertions } from 'slingshot-game-engine/testing';
 * ```
 */

export { createTestHarness, TestGameHarness } from './harness';
export type { TestHarnessConfig, TestPlayerInput } from './harness';

export { SimulatedPlayer } from './simulatedPlayer';
export type {
  SimulatedPlayerConfig,
  ChannelStrategy,
  RaceStrategy,
  StrategyContext,
} from './simulatedPlayer';

export { createMockClock } from './timeControl';
export type { MockClock } from './timeControl';

export { gameAssertions } from './assertions';
