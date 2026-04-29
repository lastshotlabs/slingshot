import { describe, expect, test } from 'bun:test';
import { SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-core';
import { createPermissionEvaluator } from '../../src/lib/evaluator';
import { createPermissionRegistry } from '../../src/lib/registry';
import { createMemoryPermissionsAdapter } from '../../src/testing';

describe('Evaluator health edge cases', () => {
  test('initial health shows zero counts', () => {
    const registry = createPermissionRegistry();
    const evaluator = createPermissionEvaluator({
      registry,
      adapter: createMemoryPermissionsAdapter(),
      queryTimeoutMs: 1000,
    });
    const health = evaluator.getHealth();
    expect(health.queryTimeoutCount).toBe(0);
    expect(health.groupExpansionErrorCount).toBe(0);
    expect(health.lastQueryTimeoutAt).toBeNull();
    expect(health.lastGroupExpansionErrorAt).toBeNull();
  });

  test('super admin always returns granted', async () => {
    const registry = createPermissionRegistry();
    const evaluator = createPermissionEvaluator({
      registry,
      adapter: createMemoryPermissionsAdapter(),
      queryTimeoutMs: 5000,
    });
    const result = await evaluator.evaluate({ role: SUPER_ADMIN_ROLE }, 'any.permission', {});
    expect(result.granted).toBe(true);
  });

  test('unknown permission returns denied', async () => {
    const registry = createPermissionRegistry();
    const evaluator = createPermissionEvaluator({
      registry,
      adapter: createMemoryPermissionsAdapter(),
      queryTimeoutMs: 5000,
    });
    const result = await evaluator.evaluate({ role: 'user' }, 'nonexistent.permission', {});
    expect(result.granted).toBe(false);
  });

  test('empty scope defaults to empty string role', async () => {
    const registry = createPermissionRegistry();
    const evaluator = createPermissionEvaluator({
      registry,
      adapter: createMemoryPermissionsAdapter(),
      queryTimeoutMs: 5000,
    });
    const result = await evaluator.evaluate({} as any, 'any.permission', {});
    expect(result.granted).toBe(false);
  });
});
