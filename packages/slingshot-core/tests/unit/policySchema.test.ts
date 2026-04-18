import { describe, expect, test } from 'bun:test';
import { entityRouteConfigSchema } from '../../src/entityRouteConfigSchema';

describe('entity policy schema validation', () => {
  test('valid policy config with auth passes', () => {
    const result = entityRouteConfigSchema.safeParse({
      defaults: { auth: 'userAuth' },
      create: {
        permission: {
          requires: 'foo:write',
          policy: { resolver: 'foo' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test('policy without any auth fails the superRefine', () => {
    const result = entityRouteConfigSchema.safeParse({
      create: {
        permission: {
          requires: 'foo:write',
          policy: { resolver: 'foo' },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('permission.policy requires auth'))).toBe(true);
    }
  });

  test('empty resolver key fails', () => {
    const result = entityRouteConfigSchema.safeParse({
      defaults: { auth: 'userAuth' },
      create: {
        permission: {
          requires: 'foo:write',
          policy: { resolver: '' },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test('invalid applyTo entry fails', () => {
    const result = entityRouteConfigSchema.safeParse({
      defaults: { auth: 'userAuth' },
      create: {
        permission: {
          requires: 'foo:write',
          policy: { resolver: 'foo', applyTo: ['bogus'] },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test('valid applyTo entries pass', () => {
    const result = entityRouteConfigSchema.safeParse({
      defaults: { auth: 'userAuth' },
      create: {
        permission: {
          requires: 'foo:write',
          policy: {
            resolver: 'foo',
            applyTo: ['create', 'get', 'list', 'update', 'delete', 'operation:closePoll'],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test('leakSafe boolean passes', () => {
    const result = entityRouteConfigSchema.safeParse({
      defaults: { auth: 'userAuth' },
      create: {
        permission: {
          requires: 'foo:write',
          policy: { resolver: 'foo', leakSafe: true },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test('policy on defaults.permission passes', () => {
    const result = entityRouteConfigSchema.safeParse({
      defaults: {
        auth: 'userAuth',
        permission: {
          requires: 'foo:read',
          policy: { resolver: 'foo' },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
