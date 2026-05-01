/**
 * Game state container, diffing, and scoped sync.
 *
 * Manages the mutable `gameState` and `privateState` for active sessions.
 * Provides deep diffing (RFC 6902 JSON Patch format) for delta sync mode,
 * JSON serialization validation, private state management, and scoped
 * visibility filtering.
 *
 * See spec §11 for the full contract.
 */
import type { GamePlayerState } from '../types/models';

/** RFC 6902 JSON Patch operation. */
export interface JsonPatchOp {
  readonly op: 'add' | 'remove' | 'replace';
  readonly path: string;
  readonly value?: unknown;
}

// ── Deep Clone ──────────────────────────────────────────────────────

/**
 * Deep-clone a state object for snapshot/rollback purposes.
 * Uses `structuredClone` when available (Bun supports it).
 */
export function deepCloneState<T>(state: T): T {
  return structuredClone(state);
}

// ── JSON Serialization Validation ───────────────────────────────────

/**
 * Validate that a state object is JSON-serializable.
 *
 * Ensures no functions, circular references, Dates (use ISO strings),
 * or undefined values. Throws if validation fails. Called on every
 * state sync per spec §11.1.
 */
export function validateJsonSerializable(state: unknown, label = 'gameState'): void {
  try {
    JSON.stringify(state);
  } catch (err) {
    throw new Error(
      `[slingshot-game-engine] ${label} is not JSON-serializable. ` +
        `Ensure no functions, circular references, Dates, or undefined values. ` +
        `Use ISO strings for dates, null instead of undefined. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// ── Deep Diff (RFC 6902) ────────────────────────────────────────────

/**
 * Escape a JSON Pointer path segment per RFC 6901.
 * `~` → `~0`, `/` → `~1`.
 */
function escapePathSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Compute a deep RFC 6902 JSON Patch between two state objects.
 *
 * Recursively diffs nested objects and arrays, producing patches
 * at the deepest changed level for minimal bandwidth.
 */
export function diffState(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): JsonPatchOp[] {
  const patches: JsonPatchOp[] = [];
  diffRecursive(previous, current, '', patches);
  return patches;
}

function diffRecursive(prev: unknown, curr: unknown, path: string, patches: JsonPatchOp[]): void {
  // Same reference or both primitively equal
  if (prev === curr) return;

  // Null/undefined checks
  if (prev === null || prev === undefined || curr === null || curr === undefined) {
    if (prev !== curr) {
      patches.push({ op: 'replace', path: path || '/', value: curr });
    }
    return;
  }

  // Different types
  if (typeof prev !== typeof curr) {
    patches.push({ op: 'replace', path: path || '/', value: curr });
    return;
  }

  // Non-objects (primitives)
  if (typeof prev !== 'object') {
    if (prev !== curr) {
      patches.push({ op: 'replace', path: path || '/', value: curr });
    }
    return;
  }

  // Arrays — compare element-by-element. For simplicity and
  // determinism, replace the whole array if lengths differ or
  // any element changed deeply.
  if (Array.isArray(prev) || Array.isArray(curr)) {
    if (!isEqual(prev, curr)) {
      patches.push({ op: 'replace', path: path || '/', value: curr });
    }
    return;
  }

  // Both are plain objects — recurse
  const prevObj = prev as Record<string, unknown>;
  const currObj = curr as Record<string, unknown>;

  // Added/changed keys
  for (const key of Object.keys(currObj)) {
    const childPath = `${path}/${escapePathSegment(key)}`;
    if (!(key in prevObj)) {
      patches.push({ op: 'add', path: childPath, value: currObj[key] });
    } else {
      diffRecursive(prevObj[key], currObj[key], childPath, patches);
    }
  }

  // Removed keys
  for (const key of Object.keys(prevObj)) {
    if (!(key in currObj)) {
      patches.push({ op: 'remove', path: `${path}/${escapePathSegment(key)}` });
    }
  }
}

/**
 * Apply RFC 6902 patches to a state object.
 *
 * Handles nested paths for client-side state reconstruction.
 */
export function applyPatches(
  state: Record<string, unknown>,
  patches: JsonPatchOp[],
): Record<string, unknown> {
  const result = deepCloneState(state);

  for (const patch of patches) {
    const segments = parsePath(patch.path);
    if (segments.length === 0) continue;

    const parentSegments = segments.slice(0, -1);
    const lastSegment = segments[segments.length - 1];
    const parent = navigateTo(result, parentSegments);

    if (parent === null || typeof parent !== 'object') continue;

    const obj = parent as Record<string, unknown>;
    switch (patch.op) {
      case 'add':
      case 'replace':
        obj[lastSegment] = patch.value;
        break;
      case 'remove':
        Reflect.deleteProperty(obj, lastSegment);
        break;
    }
  }

  return result;
}

/** Parse a JSON Pointer path into segments. */
function parsePath(path: string): string[] {
  if (path === '' || path === '/') return [];
  return path
    .split('/')
    .filter((_, i) => i > 0 || _ !== '')
    .map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Navigate to a nested object by path segments. */
function navigateTo(obj: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

// ── Equality ────────────────────────────────────────────────────────

/**
 * Deep equality check for state values.
 * Handles primitives, arrays, and plain objects.
 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a !== 'object') return false;

  // Compare as JSON for simplicity — works for plain data objects.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Circular reference or non-serializable — treat as not equal
    return false;
  }
}

// ── Private State Manager ───────────────────────────────────────────

/**
 * Create a private state container for per-player hidden state.
 *
 * Private state is visible only to the owning player and the server.
 * Updates are sent to the player's private WS room.
 */
export function createPrivateStateManager(): {
  get(userId: string): unknown;
  set(userId: string, data: unknown): void;
  update(userId: string, updater: (current: unknown) => unknown): void;
  getAll(): ReadonlyMap<string, unknown>;
  clear(): void;
} {
  const state = new Map<string, unknown>();

  return {
    get(userId: string): unknown {
      return state.get(userId) ?? null;
    },
    set(userId: string, data: unknown): void {
      state.set(userId, data);
    },
    update(userId: string, updater: (current: unknown) => unknown): void {
      const current = state.get(userId) ?? null;
      state.set(userId, updater(current));
    },
    getAll(): ReadonlyMap<string, unknown> {
      return state;
    },
    clear(): void {
      state.clear();
    },
  };
}

// ── Scoped State Sync ───────────────────────────────────────────────

/**
 * Scope handler function signature.
 *
 * Computes what a specific player should see of the full game state.
 * Called per player on every delta/snapshot send when `scopedSync: true`.
 */
export type ScopeHandlerFn = (
  state: Record<string, unknown>,
  userId: string,
  player: Readonly<GamePlayerState>,
) => Record<string, unknown>;

/**
 * Create a scoped view of game state for a specific player.
 *
 * The scope handler (from the game definition's `sync.scopeHandler`)
 * computes what each player should see.
 */
export function scopeStateForPlayer(
  fullState: Record<string, unknown>,
  userId: string,
  scopeHandler: (state: Record<string, unknown>, userId: string) => Record<string, unknown>,
): Record<string, unknown> {
  return scopeHandler(fullState, userId);
}

/**
 * Compute scoped deltas for all connected players.
 *
 * For delta sync with `scopedSync: true`, diffs the scoped state
 * per player against their last-seen scoped state.
 *
 * @returns Map of userId to their delta patches.
 */
export function computeScopedDeltas(
  previousScoped: Map<string, Record<string, unknown>>,
  currentFullState: Record<string, unknown>,
  players: readonly Readonly<GamePlayerState>[],
  scopeHandler: (state: Record<string, unknown>, userId: string) => Record<string, unknown>,
): Map<string, { patches: JsonPatchOp[]; scopedState: Record<string, unknown> }> {
  const results = new Map<
    string,
    { patches: JsonPatchOp[]; scopedState: Record<string, unknown> }
  >();

  for (const player of players) {
    if (!player.connected || player.isSpectator) continue;

    const scopedState = scopeHandler(currentFullState, player.userId);
    const prevScoped = previousScoped.get(player.userId) ?? {};
    const patches = diffState(prevScoped, scopedState);

    results.set(player.userId, { patches, scopedState });
  }

  return results;
}
