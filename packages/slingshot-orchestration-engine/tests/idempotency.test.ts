import { describe, expect, test } from 'bun:test';
import { createIdempotencyScope } from '../src/idempotency';

describe('createIdempotencyScope', () => {
  test('returns undefined when no idempotencyKey is provided', () => {
    expect(createIdempotencyScope({ type: 'task', name: 'my-task' }, {})).toBeUndefined();
  });

  test('returns undefined when idempotencyKey is an empty string', () => {
    expect(
      createIdempotencyScope({ type: 'task', name: 'my-task' }, { idempotencyKey: '' }),
    ).toBeUndefined();
  });

  test('builds a colon-separated scope string for a task', () => {
    const scope = createIdempotencyScope(
      { type: 'task', name: 'resize-image' },
      { idempotencyKey: 'job-42', tenantId: 'tenant-a' },
    );
    expect(scope).toBe('orch-idem:task:resize-image:tenant-a:job-42');
  });

  test('builds a colon-separated scope string for a workflow', () => {
    const scope = createIdempotencyScope(
      { type: 'workflow', name: 'onboarding-flow' },
      { idempotencyKey: 'user-99', tenantId: 'tenant-b' },
    );
    expect(scope).toBe('orch-idem:workflow:onboarding-flow:tenant-b:user-99');
  });

  test('defaults tenantId to "global" when not provided', () => {
    const scope = createIdempotencyScope(
      { type: 'task', name: 'my-task' },
      { idempotencyKey: 'key-1' },
    );
    expect(scope).toBe('orch-idem:task:my-task:global:key-1');
  });

  test('URL-encodes colons in the task name', () => {
    const scope = createIdempotencyScope(
      { type: 'task', name: 'namespace:my-task' },
      { idempotencyKey: 'key-1' },
    );
    // Colons in the name are percent-encoded so they don't collide with separators
    expect(scope).toContain('namespace%3Amy-task');
  });

  test('URL-encodes colons in the idempotency key', () => {
    const scope = createIdempotencyScope(
      { type: 'task', name: 'my-task' },
      { idempotencyKey: 'a:b:c' },
    );
    expect(scope).toContain('a%3Ab%3Ac');
  });

  test('different task names produce different scopes for the same key', () => {
    const a = createIdempotencyScope({ type: 'task', name: 'task-a' }, { idempotencyKey: 'key-1' });
    const b = createIdempotencyScope({ type: 'task', name: 'task-b' }, { idempotencyKey: 'key-1' });
    expect(a).not.toBe(b);
  });

  test('different tenant IDs produce different scopes for the same key', () => {
    const a = createIdempotencyScope(
      { type: 'task', name: 'my-task' },
      { idempotencyKey: 'key-1', tenantId: 'tenant-a' },
    );
    const b = createIdempotencyScope(
      { type: 'task', name: 'my-task' },
      { idempotencyKey: 'key-1', tenantId: 'tenant-b' },
    );
    expect(a).not.toBe(b);
  });

  test('task and workflow types produce different scopes for the same name and key', () => {
    const task = createIdempotencyScope(
      { type: 'task', name: 'my-op' },
      { idempotencyKey: 'key-1' },
    );
    const workflow = createIdempotencyScope(
      { type: 'workflow', name: 'my-op' },
      { idempotencyKey: 'key-1' },
    );
    expect(task).not.toBe(workflow);
  });
});
