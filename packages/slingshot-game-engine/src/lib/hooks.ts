/**
 * Lifecycle hooks dispatcher.
 *
 * Safely invokes game-defined lifecycle hooks with error isolation.
 * Each hook is called with a ProcessHandlerContext and any event-specific
 * arguments. Errors thrown by hooks are caught and logged, never propagated
 * to the caller (except onGameStart cancellation which is returned).
 *
 * See spec §19 for the full contract.
 */
import type {
  GameLifecycleHooks,
  GamePlayerState,
  ProcessHandlerContext,
  WinResult,
} from '../types/models';

/** Result of invoking `onGameStart` — may cancel the start. */
export interface GameStartResult {
  cancelled: boolean;
  reason: string | null;
}

/**
 * Invoke `onSessionCreated` hook.
 */
export async function invokeOnSessionCreated(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onSessionCreated) return;
  try {
    await hooks.onSessionCreated(ctx);
  } catch (err) {
    onError('onSessionCreated', err);
  }
}

/**
 * Invoke `onGameStart` hook.
 *
 * This hook may return `{ cancel: true, reason }` to abort the start.
 * Returns a structured result indicating whether the start was cancelled.
 */
export async function invokeOnGameStart(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  onError: (hook: string, err: unknown) => void,
): Promise<GameStartResult> {
  if (!hooks.onGameStart) return { cancelled: false, reason: null };
  try {
    const result = await hooks.onGameStart(ctx);
    if (result && typeof result === 'object' && 'cancel' in result) {
      return { cancelled: true, reason: result.reason };
    }
    return { cancelled: false, reason: null };
  } catch (err) {
    onError('onGameStart', err);
    return { cancelled: false, reason: null };
  }
}

/**
 * Invoke `onGameEnd` hook.
 */
export async function invokeOnGameEnd(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  result: WinResult,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onGameEnd) return;
  try {
    await hooks.onGameEnd(ctx, result);
  } catch (err) {
    onError('onGameEnd', err);
  }
}

/**
 * Invoke `onPhaseEnter` hook.
 */
export async function invokeOnPhaseEnter(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  phase: string,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onPhaseEnter) return;
  try {
    await hooks.onPhaseEnter(ctx, phase);
  } catch (err) {
    onError('onPhaseEnter', err);
  }
}

/**
 * Invoke `onPhaseExit` hook.
 */
export async function invokeOnPhaseExit(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  phase: string,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onPhaseExit) return;
  try {
    await hooks.onPhaseExit(ctx, phase);
  } catch (err) {
    onError('onPhaseExit', err);
  }
}

/**
 * Invoke `onTurnStart` hook.
 */
export async function invokeOnTurnStart(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  userId: string,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onTurnStart) return;
  try {
    await hooks.onTurnStart(ctx, userId);
  } catch (err) {
    onError('onTurnStart', err);
  }
}

/**
 * Invoke `onTurnEnd` hook.
 */
export async function invokeOnTurnEnd(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  userId: string,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onTurnEnd) return;
  try {
    await hooks.onTurnEnd(ctx, userId);
  } catch (err) {
    onError('onTurnEnd', err);
  }
}

/**
 * Invoke `onInput` hook.
 */
export async function invokeOnInput(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  channel: string,
  userId: string,
  data: unknown,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onInput) return;
  try {
    await hooks.onInput(ctx, channel, userId, data);
  } catch (err) {
    onError('onInput', err);
  }
}

/**
 * Invoke `onPlayerJoined` hook.
 */
export async function invokeOnPlayerJoined(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  player: GamePlayerState,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onPlayerJoined) return;
  try {
    await hooks.onPlayerJoined(ctx, player);
  } catch (err) {
    onError('onPlayerJoined', err);
  }
}

/**
 * Invoke `onPlayerDisconnected` hook.
 */
export async function invokeOnPlayerDisconnected(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  player: GamePlayerState,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onPlayerDisconnected) return;
  try {
    await hooks.onPlayerDisconnected(ctx, player);
  } catch (err) {
    onError('onPlayerDisconnected', err);
  }
}

/**
 * Invoke `onPlayerReconnected` hook.
 */
export async function invokeOnPlayerReconnected(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  player: GamePlayerState,
  onError: (hook: string, err: unknown) => void,
): Promise<void> {
  if (!hooks.onPlayerReconnected) return;
  try {
    await hooks.onPlayerReconnected(ctx, player);
  } catch (err) {
    onError('onPlayerReconnected', err);
  }
}

/** Result of invoking `onAllPlayersDisconnected`. */
export interface AllDisconnectedResult {
  abandon: boolean;
}

/**
 * Invoke `onAllPlayersDisconnected` hook.
 *
 * By default the session is abandoned. The hook can return
 * `{ abandon: false }` to keep the session alive.
 */
export async function invokeOnAllPlayersDisconnected(
  hooks: Readonly<GameLifecycleHooks>,
  ctx: ProcessHandlerContext,
  onError: (hook: string, err: unknown) => void,
): Promise<AllDisconnectedResult> {
  if (!hooks.onAllPlayersDisconnected) return { abandon: true };
  try {
    const result = await hooks.onAllPlayersDisconnected(ctx);
    if (result && typeof result === 'object' && 'abandon' in result) {
      return { abandon: false };
    }
    return { abandon: true };
  } catch (err) {
    onError('onAllPlayersDisconnected', err);
    return { abandon: true };
  }
}

/**
 * Create a hook error handler that logs via the context logger.
 *
 * Returns a callback suitable for the `onError` parameter of all
 * hook invocation functions.
 */
export function createHookErrorHandler(
  sessionId: string,
  log: { error(message: string, data?: unknown): void },
): (hook: string, err: unknown) => void {
  return (hook: string, err: unknown) => {
    log.error(`Lifecycle hook '${hook}' threw in session ${sessionId}`, {
      hook,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  };
}
