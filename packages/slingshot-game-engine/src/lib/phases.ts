/**
 * Phase state machine.
 *
 * Phase transitions, advance triggers, sub-phases, and conditional
 * navigation. All mutations happen within the session mutex.
 *
 * See spec §7 for the full contract.
 */
import type {
  GameDefinition,
  PhaseAdvanceTrigger,
  PhaseDefinition,
  ReadonlyHandlerContext,
  SubPhaseDefinition,
} from '../types/models';

/** Runtime phase state for an active session. */
export interface MutablePhaseState {
  currentPhase: string | null;
  currentSubPhase: string | null;
  phaseStartedAt: number | null;
  subPhaseIndex: number;
  resolvedNext: string | null;
  activeChannels: Set<string>;
  phaseTimerId: string | null;
}

/** Create initial phase state. */
export function createPhaseState(): MutablePhaseState {
  return {
    currentPhase: null,
    currentSubPhase: null,
    phaseStartedAt: null,
    subPhaseIndex: 0,
    resolvedNext: null,
    activeChannels: new Set(),
    phaseTimerId: null,
  };
}

/**
 * Get the first enabled phase from the definition.
 * Skips disabled phases until an enabled one is found.
 */
export function resolveFirstPhase(
  gameDef: GameDefinition,
  ctx: ReadonlyHandlerContext,
): string | null {
  const phaseNames = Object.keys(gameDef.phases);
  if (phaseNames.length === 0) return null;

  for (const name of phaseNames) {
    const def = gameDef.phases[name];
    if (isPhaseEnabled(def, ctx)) {
      return name;
    }
  }

  return null;
}

/**
 * Resolve the next phase after the current one.
 *
 * Handles static strings, conditional (`|`-separated), and dynamic
 * (function) next values. Skips disabled phases.
 */
export function resolveNextPhase(
  gameDef: GameDefinition,
  currentPhase: string,
  ctx: ReadonlyHandlerContext,
  resolvedNext: string | null,
): string | null {
  const phaseDef = gameDef.phases[currentPhase];

  let next: string | null;

  // Use manually resolved next if set (from setNextPhase)
  if (resolvedNext !== null) {
    next = resolvedNext;
  } else if (typeof phaseDef.next === 'function') {
    next = phaseDef.next(ctx);
  } else if (typeof phaseDef.next === 'string' && phaseDef.next.includes('|')) {
    // Conditional — should have been resolved by onExit handler
    // If not resolved, this is an error
    return null;
  } else {
    next = phaseDef.next;
  }

  if (next === null) return null;

  // Skip disabled phases
  const nextDef = gameDef.phases[next];
  if (!isPhaseEnabled(nextDef, ctx)) {
    // Recursively skip to the next after this disabled one
    return resolveNextPhase(gameDef, next, ctx, null);
  }

  return next;
}

/**
 * Check if a phase's `next` value is conditional (contains `|`).
 */
export function isConditionalNext(phaseDef: PhaseDefinition): boolean {
  return typeof phaseDef.next === 'string' && phaseDef.next.includes('|');
}

/**
 * Get the advance trigger for a phase, with default resolution.
 */
export function getAdvanceTrigger(
  phaseDef: PhaseDefinition | SubPhaseDefinition,
): PhaseAdvanceTrigger {
  if (phaseDef.advance) return phaseDef.advance;
  if (phaseDef.timeout !== undefined) return 'timeout';
  return 'manual';
}

/**
 * Resolve a phase's timeout value.
 * Returns null if no timeout is configured.
 */
export function resolveTimeout(
  phaseDef: PhaseDefinition | SubPhaseDefinition,
  ctx: ReadonlyHandlerContext,
): number | null {
  if (phaseDef.timeout === undefined) return null;
  return typeof phaseDef.timeout === 'function' ? phaseDef.timeout(ctx) : phaseDef.timeout;
}

/**
 * Resolve a phase's delay value.
 * Returns 0 if no delay is configured.
 */
export function resolveDelay(
  phaseDef: PhaseDefinition | SubPhaseDefinition,
  ctx: ReadonlyHandlerContext,
): number {
  if (phaseDef.delay === undefined) return 0;
  return typeof phaseDef.delay === 'function' ? phaseDef.delay(ctx) : phaseDef.delay;
}

/** Check if a phase is enabled. */
export function isPhaseEnabled(
  phaseDef: PhaseDefinition | SubPhaseDefinition,
  ctx: ReadonlyHandlerContext,
): boolean {
  if (phaseDef.enabled === undefined) return true;
  return typeof phaseDef.enabled === 'function' ? phaseDef.enabled(ctx) : phaseDef.enabled;
}

/**
 * Get the sub-phase order for a phase, or empty array if none.
 */
export function getSubPhaseOrder(phaseDef: PhaseDefinition): string[] {
  if (!phaseDef.subPhases || !phaseDef.subPhaseOrder) return [];
  return [...phaseDef.subPhaseOrder];
}

/**
 * Get the next sub-phase in a phase's sub-phase order.
 * Returns null if at the end of the sub-phase list.
 */
export function getNextSubPhase(
  phaseDef: PhaseDefinition,
  currentSubPhaseIndex: number,
  ctx: ReadonlyHandlerContext,
): { name: string; index: number } | null {
  const order = getSubPhaseOrder(phaseDef);

  for (let i = currentSubPhaseIndex + 1; i < order.length; i++) {
    const name = order[i];
    const subDef = phaseDef.subPhases?.[name];
    if (subDef && isPhaseEnabled(subDef, ctx)) {
      return { name, index: i };
    }
  }

  return null;
}

/**
 * Check if all channels in the active set are complete.
 */
export function areAllChannelsComplete(
  activeChannels: Set<string>,
  channelStates: ReadonlyMap<string, { complete: boolean }>,
): boolean {
  for (const name of activeChannels) {
    const state = channelStates.get(name);
    if (!state || !state.complete) return false;
  }
  return true;
}

/**
 * Check if any channel in the active set is complete.
 */
export function isAnyChannelComplete(
  activeChannels: Set<string>,
  channelStates: ReadonlyMap<string, { complete: boolean }>,
): boolean {
  for (const name of activeChannels) {
    const state = channelStates.get(name);
    if (state?.complete) return true;
  }
  return false;
}
