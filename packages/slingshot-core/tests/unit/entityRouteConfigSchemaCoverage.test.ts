import { describe, expect, test } from 'bun:test';
import { validateEntityRouteConfig } from '../../src/entityRouteConfigSchema';

// ---------------------------------------------------------------------------
// permission.policy requires auth — lines 239-246
// ---------------------------------------------------------------------------

describe('entityRouteConfigSchema — permission.policy requires auth', () => {
  test('rejects permission.policy on defaults without any auth enabled', () => {
    const result = validateEntityRouteConfig({
      defaults: {
        permission: {
          requires: 'posts.read',
          policy: { resolver: 'myResolver' },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.errors!.issues.map(i => i.message).join(' ');
      expect(messages).toContain('permission.policy requires auth');
    }
  });

  test('rejects permission.policy on create without auth', () => {
    const result = validateEntityRouteConfig({
      create: {
        permission: {
          requires: 'posts.create',
          policy: { resolver: 'myResolver' },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.errors!.issues.map(i => i.message).join(' ');
      expect(messages).toContain('permission.policy requires auth');
    }
  });

  test('rejects permission.policy on named operation without auth', () => {
    const result = validateEntityRouteConfig({
      operations: {
        publish: {
          permission: {
            requires: 'posts.publish',
            policy: { resolver: 'myResolver' },
          },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.errors!.issues.map(i => i.message).join(' ');
      expect(messages).toContain('permission.policy requires auth');
    }
  });

  test('accepts permission.policy when defaults.auth is userAuth', () => {
    const result = validateEntityRouteConfig({
      defaults: {
        auth: 'userAuth',
        permission: {
          requires: 'posts.read',
          policy: { resolver: 'myResolver' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts permission.policy when operation auth is bearer', () => {
    const result = validateEntityRouteConfig({
      create: {
        auth: 'bearer',
        permission: {
          requires: 'posts.create',
          policy: { resolver: 'myResolver' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts permission.policy when named operation has auth', () => {
    const result = validateEntityRouteConfig({
      operations: {
        publish: {
          auth: 'userAuth',
          permission: {
            requires: 'posts.publish',
            policy: { resolver: 'myResolver' },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
