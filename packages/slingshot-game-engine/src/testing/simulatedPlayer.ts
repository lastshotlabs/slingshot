/**
 * Simulated player for automated testing.
 *
 * Provides programmable player bots that auto-respond to channel
 * events based on configurable strategies.
 *
 * See spec §30.2 for the API contract.
 */

/** Strategy function for auto-responding to a channel. */
export type ChannelStrategy = (channelData: unknown, context: StrategyContext) => unknown;

/** Context available to strategy functions. */
export interface StrategyContext {
  /** The player's user ID. */
  userId: string;
  /** Current game state. */
  gameState: Readonly<Record<string, unknown>>;
  /** Current phase name. */
  phase: string;
  /** Seeded random for deterministic strategies. */
  random: {
    int(min: number, max: number): number;
    pick<T>(array: T[]): T;
    bool(probability?: number): boolean;
  };
}

/** Race channel strategy config. */
export interface RaceStrategy {
  /** Delay in ms before buzzing, or a function returning delay. */
  delay: number | ((ctx: StrategyContext) => number);
}

/** Configuration for a simulated player. */
export interface SimulatedPlayerConfig {
  /** Player's user ID. */
  userId: string;
  /** Player's display name. */
  displayName: string;
  /**
   * Per-channel strategy map.
   * Keys are channel names; values are strategy functions or race configs.
   */
  strategy?: Record<string, ChannelStrategy | RaceStrategy>;
}

/**
 * A simulated player bot for testing.
 *
 * Implements configurable auto-response strategies for different
 * channel types, enabling automated game testing.
 */
export class SimulatedPlayer {
  readonly userId: string;
  readonly displayName: string;
  private readonly strategies: Record<string, ChannelStrategy | RaceStrategy>;

  constructor(config: SimulatedPlayerConfig) {
    this.userId = config.userId;
    this.displayName = config.displayName;
    this.strategies = config.strategy ?? {};
  }

  /**
   * Get the response for a given channel.
   *
   * @returns The response data, or `null` if no strategy is configured.
   */
  getResponse(channelName: string, channelData: unknown, context: StrategyContext): unknown {
    const strategy = this.strategies[channelName];

    if (typeof strategy === 'function') {
      return strategy(channelData, context);
    }

    // Race strategy — return a marker (actual delay handled by harness)
    return { __raceResponse: true };
  }

  /**
   * Get the delay for a race channel response.
   *
   * @returns Delay in ms, or 0 if no race strategy is configured.
   */
  getRaceDelay(channelName: string, context: StrategyContext): number {
    const strategy = this.strategies[channelName];
    if (typeof strategy === 'function') return 0;

    return typeof strategy.delay === 'function' ? strategy.delay(context) : strategy.delay;
  }

  /**
   * Check if this player has a strategy for a channel.
   */
  hasStrategy(channelName: string): boolean {
    return channelName in this.strategies;
  }

  /**
   * Add or update a strategy for a channel.
   */
  setStrategy(channelName: string, strategy: ChannelStrategy | RaceStrategy): void {
    this.strategies[channelName] = strategy;
  }
}
