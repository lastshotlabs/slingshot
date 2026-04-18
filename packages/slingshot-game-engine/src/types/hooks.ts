/**
 * Lifecycle hook callback types for game definitions.
 *
 * These types are re-exported from `./models.ts` where the canonical
 * `GameLifecycleHooks` interface is defined. This file exists as a
 * convenience re-export surface for consumers that only need hook types.
 */

export type {
  GameLifecycleHooks,
  HandlerFunction,
  HandlerResult,
  ProcessHandlerContext,
  ReadonlyHandlerContext,
  RelayFilterFunction,
  PlayerInfo,
} from './models';
