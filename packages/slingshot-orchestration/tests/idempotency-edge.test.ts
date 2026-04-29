import { describe, expect, test } from 'bun:test';
import { createIdempotencyScope } from '../src/idempotency';
import type { IdempotencyTarget } from '../src/idempotency';

describe('createIdempotencyScope', () => {
  const taskTarget: IdempotencyTarget = { type: 'task', name: 'send-email' };
  const workflowTarget: IdempotencyTarget = { type: 'workflow', name: 'onboard-user' };

  test('returns undefined when no idempotencyKey', () => {
    expect(createIdempotencyScope(taskTarget, {})).toBeUndefined();
    expect(createIdempotencyScope(taskTarget, { idempotencyKey: '' })).toBeUndefined();
  });

  test('builds scope for task without tenant', () => {
    const scope = createIdempotencyScope(taskTarget, { idempotencyKey: 'abc123' });
    expect(scope).toBe('orch-idem:task:send-email:global:abc123');
  });

  test('builds scope for task with tenant', () => {
    const scope = createIdempotencyScope(taskTarget, {
      idempotencyKey: 'abc123',
      tenantId: 'tenant-1',
    });
    expect(scope).toBe('orch-idem:task:send-email:tenant-1:abc123');
  });

  test('builds scope for workflow', () => {
    const scope = createIdempotencyScope(workflowTarget, {
      idempotencyKey: 'wf-1',
      tenantId: 'org-5',
    });
    expect(scope).toBe('orch-idem:workflow:onboard-user:org-5:wf-1');
  });

  test('prefix is always orch-idem', () => {
    const scope = createIdempotencyScope(taskTarget, { idempotencyKey: 'x' });
    expect(scope).toStartWith('orch-idem:');
  });

  test('encodes special characters in name', () => {
    const target: IdempotencyTarget = { type: 'task', name: 'my task/with:chars' };
    const scope = createIdempotencyScope(target, { idempotencyKey: 'key:1' });
    expect(scope).toContain('my%20task%2Fwith%3Achars');
    expect(scope).toContain('key%3A1');
  });

  test('distinguishes task vs workflow with same name', () => {
    const taskScope = createIdempotencyScope({ type: 'task', name: 'process' }, { idempotencyKey: 'k' });
    const wfScope = createIdempotencyScope({ type: 'workflow', name: 'process' }, { idempotencyKey: 'k' });
    expect(taskScope).not.toBe(wfScope);
    expect(taskScope).toContain(':task:');
    expect(wfScope).toContain(':workflow:');
  });
});
