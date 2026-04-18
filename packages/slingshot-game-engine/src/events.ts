/**
 * Game engine event bus events.
 *
 * Module augmentation on `SlingshotEventMap` (the sanctioned pattern per
 * Rule 12 exception documented in spec §2.5). Client-safe events are
 * registered via `bus.registerClientSafeEvents()` in `setupPost`.
 */
import type { WinResult } from './types/models';

// Module augmentation — the game engine's typed events.
declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'game:session.created': {
      sessionId: string;
      gameType: string;
      hostUserId: string;
      tenantId: string;
    };
    'game:session.started': {
      sessionId: string;
      gameType: string;
      playerCount: number;
    };
    'game:session.completed': {
      sessionId: string;
      gameType: string;
      winResult: WinResult;
      duration: number;
    };
    'game:session.abandoned': {
      sessionId: string;
      gameType: string;
    };
    'game:player.joined': {
      sessionId: string;
      userId: string;
      gameType: string;
    };
    'game:player.disconnected': {
      sessionId: string;
      userId: string;
      gameType: string;
    };
    'game:player.reconnected': {
      sessionId: string;
      userId: string;
      gameType: string;
    };
    'game:phase.entered': {
      sessionId: string;
      gameType: string;
      phase: string;
      subPhase: string | null;
    };
    'game:input.processed': {
      sessionId: string;
      gameType: string;
      channel: string;
      userId: string;
    };
    'game:error': {
      sessionId: string;
      gameType: string;
      error: string;
      context: unknown;
    };
  }
}

/**
 * Event keys the game engine registers as client-safe (relayed to WS clients).
 *
 * Passed to `bus.registerClientSafeEvents()` in `setupPost`.
 * Events not in this list (e.g., `game:error`, `game:session.completed`
 * with internal data) stay server-side only.
 */
export const GAME_ENGINE_CLIENT_SAFE_EVENTS = [
  'game:session.created',
  'game:player.joined',
  'game:player.disconnected',
  'game:player.reconnected',
  'game:phase.entered',
] as const;
