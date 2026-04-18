/**
 * Session lease management for multi-instance mode.
 *
 * Uses Redis-backed atomic leases to ensure a session is only active
 * on one server instance at a time. The owning instance renews the
 * lease periodically. If the lease expires, another instance can
 * claim it for failover.
 *
 * See spec §32 for the full contract.
 */
import type { SessionLeaseAdapter } from '../types/adapters';

/** Default lease TTL in milliseconds. */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/** Default lease renewal interval (half the TTL for safety margin). */
export const DEFAULT_RENEWAL_INTERVAL_MS = 15_000;

/** Mutable lease management state. */
export interface MutableLeaseState {
  adapter: SessionLeaseAdapter | null;
  instanceId: string;
  leaseTtlMs: number;
  renewalIntervalMs: number;
  /** Maps sessionId to the renewal timer handle. */
  renewalHandles: Map<string, ReturnType<typeof setInterval>>;
  /** Maps sessionId to a boolean indicating current ownership. */
  ownedSessions: Set<string>;
}

/** Create initial lease state. */
export function createLeaseState(
  instanceId: string,
  adapter?: SessionLeaseAdapter | null,
  leaseTtlMs?: number,
  renewalIntervalMs?: number,
): MutableLeaseState {
  return {
    adapter: adapter ?? null,
    instanceId,
    leaseTtlMs: leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    renewalIntervalMs: renewalIntervalMs ?? DEFAULT_RENEWAL_INTERVAL_MS,
    renewalHandles: new Map(),
    ownedSessions: new Set(),
  };
}

/**
 * Acquire a lease for a session.
 *
 * If no adapter is configured (single-instance mode), always succeeds.
 * Starts automatic renewal on success.
 *
 * @returns `true` if the lease was acquired, `false` if held by another instance.
 */
export async function acquireLease(
  state: MutableLeaseState,
  sessionId: string,
  onLost?: (sessionId: string) => void,
): Promise<boolean> {
  if (!state.adapter) {
    // Single-instance mode — always owns all sessions
    state.ownedSessions.add(sessionId);
    return true;
  }

  const acquired = await state.adapter.acquireOrRenew(
    sessionId,
    state.instanceId,
    state.leaseTtlMs,
  );

  if (!acquired) return false;

  state.ownedSessions.add(sessionId);
  startRenewal(state, sessionId, onLost);
  return true;
}

/**
 * Release a lease for a session.
 *
 * Stops renewal and releases ownership.
 */
export async function releaseLease(state: MutableLeaseState, sessionId: string): Promise<void> {
  stopRenewal(state, sessionId);
  state.ownedSessions.delete(sessionId);

  if (state.adapter) {
    await state.adapter.release(sessionId, state.instanceId);
  }
}

/**
 * Check if this instance currently owns a session's lease.
 *
 * In single-instance mode (no adapter), always returns `true`
 * for sessions in the owned set.
 */
export function isLeaseOwner(state: MutableLeaseState, sessionId: string): boolean {
  return state.ownedSessions.has(sessionId);
}

/**
 * Get the current lease holder for a session.
 *
 * @returns The instance ID of the holder, or `null` if no lease is active.
 * In single-instance mode, returns this instance's ID if owned.
 */
export async function getLeaseHolder(
  state: MutableLeaseState,
  sessionId: string,
): Promise<string | null> {
  if (!state.adapter) {
    return state.ownedSessions.has(sessionId) ? state.instanceId : null;
  }
  return state.adapter.getHolder(sessionId);
}

/**
 * Release all leases and stop all renewal timers.
 * Called during shutdown.
 */
export async function releaseAllLeases(state: MutableLeaseState): Promise<void> {
  const sessionIds = [...state.ownedSessions];
  for (const sessionId of sessionIds) {
    stopRenewal(state, sessionId);
  }
  state.ownedSessions.clear();

  if (state.adapter) {
    // Release each lease — best-effort during shutdown
    await Promise.allSettled(
      sessionIds.map(id => state.adapter?.release(id, state.instanceId) ?? Promise.resolve()),
    );
  }
}

/** Start automatic lease renewal for a session. */
function startRenewal(
  state: MutableLeaseState,
  sessionId: string,
  onLost?: (sessionId: string) => void,
): void {
  // Don't start if already running or no adapter
  if (state.renewalHandles.has(sessionId) || !state.adapter) return;

  const handle = setInterval(async () => {
    if (!state.adapter) return;

    const renewed = await state.adapter.acquireOrRenew(
      sessionId,
      state.instanceId,
      state.leaseTtlMs,
    );

    if (!renewed) {
      // Lease lost — another instance has taken over
      stopRenewal(state, sessionId);
      state.ownedSessions.delete(sessionId);
      onLost?.(sessionId);
    }
  }, state.renewalIntervalMs);

  state.renewalHandles.set(sessionId, handle);
}

/** Stop automatic lease renewal for a session. */
function stopRenewal(state: MutableLeaseState, sessionId: string): void {
  const handle = state.renewalHandles.get(sessionId);
  if (handle) {
    clearInterval(handle);
    state.renewalHandles.delete(sessionId);
  }
}
