/**
 * Mutable player record for runtime use.
 *
 * Internal only. Handler contexts convert this to the read-only
 * `GamePlayerState` public surface.
 */
export interface MutablePlayer {
  userId: string;
  displayName: string;
  role: string | null;
  team: string | null;
  playerState: string | null;
  score: number;
  connected: boolean;
  isHost: boolean;
  isSpectator: boolean;
  joinOrder: number;
  disconnectedAt: Date | null;
  disconnectCount: number;
}
