/**
 * Unit tests for validateAndSortPlugins.
 *
 * Covers: empty input, missing lifecycle methods, standalone-only plugins,
 * missing dependencies, circular dependencies, cross-phase violations,
 * and correct topological ordering.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { validateAndSortPlugins } from '../../src/framework/runPluginLifecycle';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noop() {}
const asyncNoop = async () => {};

function makePlugin(
  name: string,
  phase: 'middleware' | 'routes' | 'post' | 'setup' | 'all',
  deps?: string[],
): SlingshotPlugin {
  const base: SlingshotPlugin = { name };
  if (deps) base.dependencies = deps;
  if (phase === 'middleware' || phase === 'all') base.setupMiddleware = asyncNoop;
  if (phase === 'routes' || phase === 'all') base.setupRoutes = asyncNoop;
  if (phase === 'post' || phase === 'all') base.setupPost = asyncNoop;
  if (phase === 'setup') base.setup = asyncNoop;
  return base;
}

// ---------------------------------------------------------------------------
// Empty / trivial
// ---------------------------------------------------------------------------

describe('validateAndSortPlugins — empty / trivial', () => {
  test('returns empty array when plugins array is empty', () => {
    expect(validateAndSortPlugins([])).toEqual([]);
  });

  test('single plugin with no dependencies returns [plugin]', () => {
    const p = makePlugin('alpha', 'middleware');
    const result = validateAndSortPlugins([p]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle validation
// ---------------------------------------------------------------------------

describe('validateAndSortPlugins — lifecycle validation', () => {
  test('throws when plugin has no lifecycle methods at all', () => {
    const bad: SlingshotPlugin = { name: 'ghost' };
    expect(() => validateAndSortPlugins([bad])).toThrow(/ghost/);
    expect(() => validateAndSortPlugins([bad])).toThrow(/at least one of/);
  });

  test('throws when two plugins share the same name', () => {
    const first = makePlugin('duplicate', 'middleware');
    const second = makePlugin('duplicate', 'routes');
    expect(() => validateAndSortPlugins([first, second])).toThrow(/Duplicate plugin name/);
  });

  test('setup()-only plugin is not returned (standalone-only)', () => {
    const p = makePlugin('standalone', 'setup');
    const result = validateAndSortPlugins([p]);
    // Standalone-only plugins are valid but not included in framework phases
    expect(result).toHaveLength(0);
  });

  test('setup()-only plugin logs info (not an error)', () => {
    const spy = spyOn(console, 'info').mockImplementation(noop);
    const p = makePlugin('standalone', 'setup');
    validateAndSortPlugins([p]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

describe('validateAndSortPlugins — dependency resolution', () => {
  test('throws when a declared dependency is not in the plugins array', () => {
    const b = makePlugin('b', 'middleware', ['missing-dep']);
    expect(() => validateAndSortPlugins([b])).toThrow(/"missing-dep"/);
    expect(() => validateAndSortPlugins([b])).toThrow(/"b"/);
  });

  test('places dependency before dependent in output', () => {
    const a = makePlugin('a', 'middleware');
    const b = makePlugin('b', 'middleware', ['a']);
    // Supply in reverse order — topological sort must fix it
    const result = validateAndSortPlugins([b, a]);
    const names = result.map(p => p.name);
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('b'));
  });

  test('handles a diamond dependency graph (A→B, A→C, B→D, C→D)', () => {
    const d = makePlugin('d', 'middleware');
    const b = makePlugin('b', 'middleware', ['d']);
    const c = makePlugin('c', 'middleware', ['d']);
    const a = makePlugin('a', 'middleware', ['b', 'c']);
    const result = validateAndSortPlugins([a, b, c, d]);
    const names = result.map(p => p.name);
    // d must come before b and c; b and c before a
    expect(names.indexOf('d')).toBeLessThan(names.indexOf('b'));
    expect(names.indexOf('d')).toBeLessThan(names.indexOf('c'));
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('a'));
    expect(names.indexOf('c')).toBeLessThan(names.indexOf('a'));
  });
});

// ---------------------------------------------------------------------------
// Circular dependency detection
// ---------------------------------------------------------------------------

describe('validateAndSortPlugins — circular dependency detection', () => {
  test('throws on direct self-dependency (A → A)', () => {
    const a = makePlugin('a', 'middleware', ['a']);
    expect(() => validateAndSortPlugins([a])).toThrow(/[Cc]ircular/);
  });

  test('throws on two-plugin cycle (A → B → A)', () => {
    const a = makePlugin('a', 'middleware', ['b']);
    const b = makePlugin('b', 'middleware', ['a']);
    expect(() => validateAndSortPlugins([a, b])).toThrow(/[Cc]ircular/);
  });

  test('error message includes the cycle path', () => {
    const a = makePlugin('a', 'middleware', ['b']);
    const b = makePlugin('b', 'middleware', ['c']);
    const c = makePlugin('c', 'middleware', ['a']);
    let msg = '';
    try {
      validateAndSortPlugins([a, b, c]);
    } catch (err) {
      msg = (err as Error).message;
    }
    // The cycle a → b → c → a should appear in the message
    expect(msg).toMatch(/a.*b|b.*c|c.*a/);
  });
});

// ---------------------------------------------------------------------------
// Cross-phase dependency validation
// ---------------------------------------------------------------------------

describe('validateAndSortPlugins — cross-phase dependency validation', () => {
  test('throws when setupMiddleware plugin depends on setupPost plugin', () => {
    // middleware (phase 0) depends on post (phase 2) — violated: dep phase > dependent phase
    const late = makePlugin('late', 'post');
    const early = makePlugin('early', 'middleware', ['late']);
    expect(() => validateAndSortPlugins([early, late])).toThrow(/setupPost/);
    expect(() => validateAndSortPlugins([early, late])).toThrow(/setupMiddleware/);
  });

  test('throws when setupRoutes plugin depends on setupPost plugin', () => {
    const post = makePlugin('post-plugin', 'post');
    const routes = makePlugin('routes-plugin', 'routes', ['post-plugin']);
    expect(() => validateAndSortPlugins([routes, post])).toThrow(/[Pp]hase/);
  });

  test('allows setupPost plugin to depend on setupMiddleware plugin', () => {
    // post (phase 2) depends on middleware (phase 0) — valid: dep phase <= dependent phase
    const mw = makePlugin('mw', 'middleware');
    const post = makePlugin('post', 'post', ['mw']);
    expect(() => validateAndSortPlugins([post, mw])).not.toThrow();
  });

  test('allows same-phase dependencies', () => {
    const a = makePlugin('a', 'routes');
    const b = makePlugin('b', 'routes', ['a']);
    expect(() => validateAndSortPlugins([a, b])).not.toThrow();
  });

  test('standalone-only (setup) plugins skip cross-phase validation', () => {
    // Standalone depends on a framework plugin — should not throw cross-phase error
    const fw = makePlugin('framework', 'middleware');
    const standalone = makePlugin('standalone', 'setup', ['framework']);
    expect(() => validateAndSortPlugins([fw, standalone])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Output ordering guarantees
// ---------------------------------------------------------------------------

describe('validateAndSortPlugins — output ordering', () => {
  test('three-plugin chain returns in dependency order', () => {
    const a = makePlugin('a', 'middleware');
    const b = makePlugin('b', 'routes', ['a']);
    const c = makePlugin('c', 'post', ['b']);
    const result = validateAndSortPlugins([c, b, a]); // intentionally reversed input
    const names = result.map(p => p.name);
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('b'));
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('c'));
  });

  test('independent plugins maintain relative input order', () => {
    const a = makePlugin('a', 'middleware');
    const b = makePlugin('b', 'middleware');
    const c = makePlugin('c', 'middleware');
    const result = validateAndSortPlugins([a, b, c]);
    // No deps — topological sort should preserve original order for independent nodes
    expect(result.map(p => p.name)).toEqual(['a', 'b', 'c']);
  });
});
