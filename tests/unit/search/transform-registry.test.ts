import { describe, expect, test } from 'bun:test';
import { createSearchTransformRegistry } from '../../../packages/slingshot-search/src/transformRegistry';

// ============================================================================
// Tests
// ============================================================================

describe('SearchTransformRegistry', () => {
  // --------------------------------------------------------------------------
  // register
  // --------------------------------------------------------------------------

  describe('register', () => {
    test('registers a named transform', () => {
      const registry = createSearchTransformRegistry();
      const fn = (doc: Record<string, unknown>) => ({ id: doc.id });
      registry.register('flatten', fn);
      expect(registry.has('flatten')).toBe(true);
    });

    test('registered transform appears in names()', () => {
      const registry = createSearchTransformRegistry();
      registry.register('a', doc => doc);
      registry.register('b', doc => doc);
      const names = registry.names();
      expect(names).toContain('a');
      expect(names).toContain('b');
    });
  });

  // --------------------------------------------------------------------------
  // resolve
  // --------------------------------------------------------------------------

  describe('resolve', () => {
    test('returns the registered function by name', () => {
      const registry = createSearchTransformRegistry();
      const fn = (doc: Record<string, unknown>) => ({ id: doc.id });
      registry.register('flatten', fn);

      const resolved = registry.resolve('flatten');
      expect(resolved).toBe(fn);
    });

    test('returns identity function when name is undefined', () => {
      const registry = createSearchTransformRegistry();
      const identity = registry.resolve(undefined);
      const doc = { id: '1', title: 'Test' };
      expect(identity(doc)).toBe(doc);
    });

    test('identity function returns the same object reference', () => {
      const registry = createSearchTransformRegistry();
      const identity = registry.resolve();
      const doc = { foo: 'bar' };
      expect(identity(doc)).toBe(doc);
    });
  });

  // --------------------------------------------------------------------------
  // Duplicate registration error
  // --------------------------------------------------------------------------

  describe('duplicate registration', () => {
    test('throws when registering the same name twice', () => {
      const registry = createSearchTransformRegistry();
      registry.register('flatten', doc => doc);
      expect(() => registry.register('flatten', doc => doc)).toThrow(/already registered/);
    });
  });

  // --------------------------------------------------------------------------
  // Unknown transform error
  // --------------------------------------------------------------------------

  describe('unknown transform', () => {
    test('throws when resolving an unregistered name', () => {
      const registry = createSearchTransformRegistry();
      expect(() => registry.resolve('nonexistent')).toThrow(/Unknown transform/);
    });

    test('error message includes registered names', () => {
      const registry = createSearchTransformRegistry();
      registry.register('a', doc => doc);
      try {
        registry.resolve('missing');
      } catch (e: any) {
        expect(e.message).toContain('a');
      }
    });
  });

  // --------------------------------------------------------------------------
  // has
  // --------------------------------------------------------------------------

  describe('has', () => {
    test('returns false for unregistered name', () => {
      const registry = createSearchTransformRegistry();
      expect(registry.has('nonexistent')).toBe(false);
    });

    test('returns true for registered name', () => {
      const registry = createSearchTransformRegistry();
      registry.register('test', doc => doc);
      expect(registry.has('test')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Isolation — separate registry instances
  // --------------------------------------------------------------------------

  test('separate registry instances are isolated', () => {
    const r1 = createSearchTransformRegistry();
    const r2 = createSearchTransformRegistry();
    r1.register('only-in-r1', doc => doc);
    expect(r1.has('only-in-r1')).toBe(true);
    expect(r2.has('only-in-r1')).toBe(false);
  });
});
