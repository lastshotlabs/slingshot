/**
 * Events this package emits, as a `SlingshotEventMap` augmentation.
 *
 * There is exactly one, and it is the one an operator actually needs: the spend
 * soft limit. A hard limit throws (`AiSpendLimitError`) and is impossible to
 * miss; a SOFT limit is the warning shot, and a warning nobody can subscribe to
 * is a warning nobody acts on.
 */
import type { SpendStatus } from './types';

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    /**
     * The AI spend for the current period crossed `spend.softLimitUsd`.
     *
     * Fired ONCE per period, not once per call — an alert that fires on every
     * subsequent request is an alert that gets muted.
     */
    'ai:spend.soft_limit': SpendStatus;
  }
}

export {};
