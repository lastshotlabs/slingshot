import { describe, expect, test } from 'bun:test';
import { createPermissionEvaluator } from '../../src/lib/evaluator';
import { createPermissionRegistry } from '../../src/lib/registry';
import { createMemoryPermissionsAdapter } from '../../src/testing';

describe('Evaluator health edge cases', () => {
  test('initial health shows zero counts', () => {
    const registry = createPermissionRegistry();
    const adapter = createMemoryPermissionsAdapter();
    const evaluator = createPermissionEvaluator({
      registry,
      adapter,
      queryTimeoutMs: 1000,
    });
    const health = evaluator.getHealth();
    expect(health.queryTimeoutCount).toBe(0);
    expect(health.groupExpansionErrorCount).toBe(0);
    expect(health.lastQueryTimeoutAt).toBeNull();
    expect(health.lastGroupExpansionErrorAt).toBeNull();
  });

  test('evaluator with queryTimeoutMs exposes evaluate', () => {
    const registry = createPermissionRegistry();
    const adapter = createMemoryPermissionsAdapter();
    const evaluator = createPermissionEvaluator({
      registry,
      adapter,
      queryTimeoutMs: 5000,
    });
    expect(evaluator).toBeDefined();
    expect(typeof evaluator.can).toBe('function');
    expect(typeof evaluator.getHealth).toBe('function');
  });

  test('evaluator with maxGroups option', () => {
    const registry = createPermissionRegistry();
    const adapter = createMemoryPermissionsAdapter();
    const evaluator = createPermissionEvaluator({
      registry,
      adapter,
      maxGroups: 100,
    });
    expect(evaluator).toBeDefined();
  });

  test('evaluator with both maxGroups and queryTimeoutMs', () => {
    const registry = createPermissionRegistry();
    const adapter = createMemoryPermissionsAdapter();
    const evaluator = createPermissionEvaluator({
      registry,
      adapter,
      maxGroups: 200,
      queryTimeoutMs: 5000,
    });
    const health = evaluator.getHealth();
    expect(health.queryTimeoutCount).toBe(0);
  });
});
