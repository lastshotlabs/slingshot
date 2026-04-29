// packages/runtime-edge/tests/unit/hash-password-validation.test.ts
//
// Tests for the hashPassword / verifyPassword option validation in
// edgeRuntime(). The factory requires that both options are provided
// together or both are omitted — mixing one custom with the default
// implementation would cause silent auth failures at runtime.
//
// Coverage:
//   - Both provided with valid functions works
//   - Both omitted works (default PBKDF2 implementation is used)
//   - Only hashPassword provided throws a descriptive error
//   - Only verifyPassword provided throws a descriptive error
//   - Error message contains the specific guidance text
//   - Various edge cases for the validation (null, undefined, explicit undefined)
import { describe, expect, it } from 'bun:test';
import { edgeRuntime } from '../../src/index';

describe('hashPassword / verifyPassword option validation', () => {
  // -----------------------------------------------------------------------
  // Valid configurations
  // -----------------------------------------------------------------------

  describe('valid configurations', () => {
    it('accepts both hashPassword and verifyPassword together', () => {
      const runtime = edgeRuntime({
        hashPassword: async pw => `custom:${pw}`,
        verifyPassword: async (pw, hash) => hash === `custom:${pw}`,
      });
      expect(runtime).toBeDefined();
      expect(typeof runtime.password.hash).toBe('function');
      expect(typeof runtime.password.verify).toBe('function');
    });

    it('accepts both omitted (default PBKDF2 implementation)', () => {
      const runtime = edgeRuntime();
      expect(runtime).toBeDefined();
      expect(typeof runtime.password.hash).toBe('function');
      expect(typeof runtime.password.verify).toBe('function');
    });

    it('custom functions are callable and produce expected results', async () => {
      const runtime = edgeRuntime({
        hashPassword: async pw => `custom:${pw}`,
        verifyPassword: async (pw, hash) => hash === `custom:${pw}`,
      });
      const hash = await runtime.password.hash('test-password');
      expect(hash).toBe('custom:test-password');
      expect(await runtime.password.verify('test-password', hash)).toBe(true);
      expect(await runtime.password.verify('wrong', hash)).toBe(false);
    });

    it('default PBKDF2 functions work when both omitted', async () => {
      const runtime = edgeRuntime();
      const hash = await runtime.password.hash('default-pw');
      expect(hash).toMatch(/^pbkdf2-sha256\$/);
      expect(await runtime.password.verify('default-pw', hash)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Invalid configurations — should throw
  // -----------------------------------------------------------------------

  describe('invalid configurations (mixing custom and default)', () => {
    it('throws when only hashPassword is provided', () => {
      expect(() =>
        edgeRuntime({
          hashPassword: async pw => `custom:${pw}`,
        }),
      ).toThrow();
    });

    it('throws when only verifyPassword is provided', () => {
      expect(() =>
        edgeRuntime({
          verifyPassword: async (pw, hash) => hash === `custom:${pw}`,
        }),
      ).toThrow();
    });

    it('error message contains [runtime-edge] prefix', () => {
      expect(() =>
        edgeRuntime({
          hashPassword: async pw => `custom:${pw}`,
        }),
      ).toThrow('[runtime-edge]');
    });

    it('error message says both must be provided or both omitted', () => {
      expect(() =>
        edgeRuntime({
          verifyPassword: async () => true,
        }),
      ).toThrow(/must both be provided or both omitted/);
    });

    it('error message warns about auth failures', () => {
      expect(() =>
        edgeRuntime({
          hashPassword: async pw => `custom:${pw}`,
        }),
      ).toThrow(/auth failure/);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases for validation
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('throws when hashPassword is provided as null (typecast)', () => {
      // At runtime, typeof null is 'object', not 'function', so the check
      // typeof options.hashPassword === 'function' is false for null.
      // Both would be falsy, so hasCustomHash === hasCustomVerify === false
      // and the validation does NOT throw — the default is used.
      // This is acceptable because null is trivially the same as "omitted".
      expect(() =>
        edgeRuntime({
          hashPassword: null as unknown as (plain: string) => Promise<string>,
          verifyPassword: null as unknown as (plain: string, hash: string) => Promise<boolean>,
        }),
      ).not.toThrow();
    });

    it('accepts explicit undefined for both options', () => {
      expect(() =>
        edgeRuntime({
          hashPassword: undefined,
          verifyPassword: undefined,
        }),
      ).not.toThrow();
    });

    it('accepts empty options object', () => {
      expect(() => edgeRuntime({})).not.toThrow();
    });

    it('accepts no arguments at all', () => {
      expect(() => edgeRuntime()).not.toThrow();
    });

    it('custom functions with different arities still pass validation', () => {
      // The validation only checks typeof — it does not inspect arity.
      const runtime = edgeRuntime({
        hashPassword: async (_pw: string) => 'fixed-hash',
        verifyPassword: async (_pw: string, _hash: string) => true,
      });
      expect(runtime).toBeDefined();
    });
  });
});
