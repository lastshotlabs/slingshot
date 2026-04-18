/**
 * Unit tests for the game state container, diffing, and scoped sync.
 *
 * Tests deepCloneState, validateJsonSerializable, diffState (RFC 6902),
 * applyPatches, createPrivateStateManager, scopeStateForPlayer, and
 * computeScopedDeltas.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyPatches,
  computeScopedDeltas,
  createPrivateStateManager,
  deepCloneState,
  diffState,
  scopeStateForPlayer,
  validateJsonSerializable,
} from '../../src/lib/state';
import type { GamePlayerState } from '../../src/types/models';

describe('deepCloneState', () => {
  test('produces a structurally equal but independent copy', () => {
    const original = { a: 1, b: { c: [2, 3] } };
    const cloned = deepCloneState(original);
    expect(cloned).toEqual(original);
    cloned.b.c.push(4);
    expect(original.b.c).toEqual([2, 3]);
  });

  test('clones arrays', () => {
    const original = [1, 2, { x: 3 }];
    const cloned = deepCloneState(original);
    expect(cloned).toEqual(original);
    (cloned[2] as Record<string, number>).x = 99;
    expect((original[2] as Record<string, number>).x).toBe(3);
  });

  test('handles primitives', () => {
    expect(deepCloneState(42)).toBe(42);
    expect(deepCloneState('hello')).toBe('hello');
    expect(deepCloneState(null)).toBeNull();
  });
});

describe('validateJsonSerializable', () => {
  test('accepts plain JSON-compatible objects', () => {
    expect(() => validateJsonSerializable({ a: 1, b: 'hello', c: [true, null] })).not.toThrow();
  });

  test('accepts empty objects and arrays', () => {
    expect(() => validateJsonSerializable({})).not.toThrow();
    expect(() => validateJsonSerializable([])).not.toThrow();
  });

  test('throws for circular references', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => validateJsonSerializable(obj)).toThrow('not JSON-serializable');
  });

  test('includes custom label in error message', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => validateJsonSerializable(obj, 'myState')).toThrow('myState');
  });
});

describe('diffState', () => {
  test('returns empty array for identical objects', () => {
    const state = { score: 10, name: 'alice' };
    expect(diffState(state, { ...state })).toEqual([]);
  });

  test('detects added keys', () => {
    const prev = { a: 1 };
    const curr = { a: 1, b: 2 };
    const patches = diffState(prev, curr);
    expect(patches).toEqual([{ op: 'add', path: '/b', value: 2 }]);
  });

  test('detects removed keys', () => {
    const prev = { a: 1, b: 2 };
    const curr = { a: 1 };
    const patches = diffState(prev, curr);
    expect(patches).toEqual([{ op: 'remove', path: '/b' }]);
  });

  test('detects replaced values', () => {
    const prev = { a: 1 };
    const curr = { a: 2 };
    const patches = diffState(prev, curr);
    expect(patches).toEqual([{ op: 'replace', path: '/a', value: 2 }]);
  });

  test('handles nested object changes', () => {
    const prev = { nested: { x: 1, y: 2 } };
    const curr = { nested: { x: 1, y: 3 } };
    const patches = diffState(prev, curr);
    expect(patches).toEqual([{ op: 'replace', path: '/nested/y', value: 3 }]);
  });

  test('handles type changes', () => {
    const prev = { a: 'string' as unknown } as Record<string, unknown>;
    const curr = { a: 42 as unknown } as Record<string, unknown>;
    const patches = diffState(prev, curr);
    expect(patches).toEqual([{ op: 'replace', path: '/a', value: 42 }]);
  });

  test('detects array replacement when content changes', () => {
    const prev = { items: [1, 2, 3] as unknown } as Record<string, unknown>;
    const curr = { items: [1, 2, 4] as unknown } as Record<string, unknown>;
    const patches = diffState(prev, curr);
    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('replace');
    expect(patches[0].path).toBe('/items');
  });

  test('returns empty for identical nested structures', () => {
    const prev = { a: { b: { c: 1 } } };
    const curr = { a: { b: { c: 1 } } };
    expect(diffState(prev, curr)).toEqual([]);
  });
});

describe('applyPatches', () => {
  test('applies add operation', () => {
    const state = { a: 1 };
    const result = applyPatches(state, [{ op: 'add', path: '/b', value: 2 }]);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  test('applies replace operation', () => {
    const state = { a: 1 };
    const result = applyPatches(state, [{ op: 'replace', path: '/a', value: 99 }]);
    expect(result).toEqual({ a: 99 });
  });

  test('applies remove operation', () => {
    const state = { a: 1, b: 2 };
    const result = applyPatches(state, [{ op: 'remove', path: '/b' }]);
    expect(result).toEqual({ a: 1 });
  });

  test('does not mutate original state', () => {
    const state = { a: 1, b: 2 };
    applyPatches(state, [{ op: 'remove', path: '/b' }]);
    expect(state).toEqual({ a: 1, b: 2 });
  });

  test('applies nested patches', () => {
    const state = { nested: { x: 1 } };
    const result = applyPatches(state, [{ op: 'replace', path: '/nested/x', value: 42 }]);
    expect(result).toEqual({ nested: { x: 42 } });
  });

  test('roundtrips with diffState', () => {
    const prev = { a: 1, b: { c: 2, d: 3 } };
    const curr = { a: 1, b: { c: 99, d: 3 }, e: 'new' };
    const patches = diffState(prev, curr);
    const result = applyPatches(prev, patches);
    expect(result).toEqual(curr);
  });
});

describe('createPrivateStateManager', () => {
  test('get returns null for unknown player', () => {
    const mgr = createPrivateStateManager();
    expect(mgr.get('unknown')).toBeNull();
  });

  test('set and get roundtrip', () => {
    const mgr = createPrivateStateManager();
    mgr.set('alice', { hand: ['ace', 'king'] });
    expect(mgr.get('alice')).toEqual({ hand: ['ace', 'king'] });
  });

  test('update applies transformation', () => {
    const mgr = createPrivateStateManager();
    mgr.set('alice', { count: 1 });
    mgr.update('alice', current => {
      const c = current as { count: number };
      return { count: c.count + 1 };
    });
    expect(mgr.get('alice')).toEqual({ count: 2 });
  });

  test('update handles null initial state', () => {
    const mgr = createPrivateStateManager();
    mgr.update('bob', current => current ?? { initialized: true });
    expect(mgr.get('bob')).toEqual({ initialized: true });
  });

  test('getAll returns read-only map', () => {
    const mgr = createPrivateStateManager();
    mgr.set('alice', 'a');
    mgr.set('bob', 'b');
    const all = mgr.getAll();
    expect(all.size).toBe(2);
    expect(all.get('alice')).toBe('a');
  });

  test('clear removes all entries', () => {
    const mgr = createPrivateStateManager();
    mgr.set('alice', 'data');
    mgr.clear();
    expect(mgr.get('alice')).toBeNull();
    expect(mgr.getAll().size).toBe(0);
  });
});

describe('scopeStateForPlayer', () => {
  test('applies scope handler to filter state', () => {
    const fullState = { shared: 1, secret: 'hidden' };
    const scoped = scopeStateForPlayer(fullState, 'alice', state => ({ shared: state.shared }));
    expect(scoped).toEqual({ shared: 1 });
    expect('secret' in scoped).toBeFalse();
  });

  test('passes userId to scope handler', () => {
    const fullState = { scores: { alice: 10, bob: 20 } };
    const scoped = scopeStateForPlayer(fullState, 'alice', (state, userId) => {
      const scores = state.scores as Record<string, number>;
      return { myScore: scores[userId] };
    });
    expect(scoped).toEqual({ myScore: 10 });
  });
});

describe('computeScopedDeltas', () => {
  function makePlayer(userId: string, overrides: Partial<GamePlayerState> = {}): GamePlayerState {
    return {
      userId,
      displayName: userId,
      role: null,
      team: null,
      playerState: null,
      score: 0,
      connected: true,
      isHost: false,
      isSpectator: false,
      joinOrder: 0,
      ...overrides,
    };
  }

  test('computes deltas for connected players', () => {
    const previousScoped = new Map<string, Record<string, unknown>>();
    previousScoped.set('alice', { x: 1 });
    previousScoped.set('bob', { x: 1 });

    const currentFullState = { x: 2 };
    const players = [makePlayer('alice'), makePlayer('bob')];
    const scopeHandler = (state: Record<string, unknown>) => ({ ...state });

    const result = computeScopedDeltas(previousScoped, currentFullState, players, scopeHandler);
    expect(result.size).toBe(2);
    const aliceResult = result.get('alice')!;
    expect(aliceResult.patches).toHaveLength(1);
    expect(aliceResult.patches[0]).toEqual({ op: 'replace', path: '/x', value: 2 });
  });

  test('skips disconnected players', () => {
    const previousScoped = new Map<string, Record<string, unknown>>();
    const currentFullState = { x: 1 };
    const players = [
      makePlayer('alice', { connected: true }),
      makePlayer('bob', { connected: false }),
    ];
    const scopeHandler = (state: Record<string, unknown>) => ({ ...state });

    const result = computeScopedDeltas(previousScoped, currentFullState, players, scopeHandler);
    expect(result.has('alice')).toBeTrue();
    expect(result.has('bob')).toBeFalse();
  });

  test('skips spectators', () => {
    const previousScoped = new Map<string, Record<string, unknown>>();
    const currentFullState = { x: 1 };
    const players = [
      makePlayer('alice', { isSpectator: false }),
      makePlayer('bob', { isSpectator: true }),
    ];
    const scopeHandler = (state: Record<string, unknown>) => ({ ...state });

    const result = computeScopedDeltas(previousScoped, currentFullState, players, scopeHandler);
    expect(result.has('alice')).toBeTrue();
    expect(result.has('bob')).toBeFalse();
  });

  test('uses empty object as previous when no prior scoped state', () => {
    const previousScoped = new Map<string, Record<string, unknown>>();
    const currentFullState = { x: 1 };
    const players = [makePlayer('alice')];
    const scopeHandler = (state: Record<string, unknown>) => ({ ...state });

    const result = computeScopedDeltas(previousScoped, currentFullState, players, scopeHandler);
    const aliceResult = result.get('alice')!;
    expect(aliceResult.patches).toHaveLength(1);
    expect(aliceResult.patches[0]).toEqual({ op: 'add', path: '/x', value: 1 });
  });
});
