import { describe, expect, test } from 'bun:test';
import { deriveTemporalRunId } from '../src/ids';

describe('deriveTemporalRunId', () => {
  test('derives stable run ids for idempotent starts', () => {
    const first = deriveTemporalRunId({
      kind: 'workflow',
      name: 'ship-order',
      tenantId: 'tenant-a',
      idempotencyKey: 'order-123',
    });
    const second = deriveTemporalRunId({
      kind: 'workflow',
      name: 'ship-order',
      tenantId: 'tenant-a',
      idempotencyKey: 'order-123',
    });
    const different = deriveTemporalRunId({
      kind: 'workflow',
      name: 'ship-order',
      tenantId: 'tenant-a',
      idempotencyKey: 'order-456',
    });

    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first.startsWith('run_')).toBe(true);
  });

  test('generates unique ids when no idempotencyKey is provided', () => {
    const first = deriveTemporalRunId({
      kind: 'task',
      name: 'send-email',
      tenantId: 'tenant-b',
    });
    const second = deriveTemporalRunId({
      kind: 'task',
      name: 'send-email',
      tenantId: 'tenant-b',
    });

    // Without an idempotency key, each call returns a unique run ID
    expect(first).not.toBe(second);
    expect(first.startsWith('run_')).toBe(true);
    expect(second.startsWith('run_')).toBe(true);
    expect(first.length).toBeGreaterThan(10);
  });

  test('different task names produce different deterministic ids', () => {
    const idA = deriveTemporalRunId({
      kind: 'task',
      name: 'process-order',
      tenantId: 'tenant-a',
      idempotencyKey: 'key-1',
    });
    const idB = deriveTemporalRunId({
      kind: 'task',
      name: 'refund-order',
      tenantId: 'tenant-a',
      idempotencyKey: 'key-1',
    });

    expect(idA).not.toBe(idB);
  });

  test('different kinds with same name produce different ids', () => {
    const idTask = deriveTemporalRunId({
      kind: 'task',
      name: 'same-name',
      tenantId: 'tenant-a',
      idempotencyKey: 'key-1',
    });
    const idWf = deriveTemporalRunId({
      kind: 'workflow',
      name: 'same-name',
      tenantId: 'tenant-a',
      idempotencyKey: 'key-1',
    });

    expect(idTask).not.toBe(idWf);
  });

  test('different tenants produce different deterministic ids', () => {
    const tenantA = deriveTemporalRunId({
      kind: 'workflow',
      name: 'my-workflow',
      tenantId: 'tenant-a',
      idempotencyKey: 'shared-key',
    });
    const tenantB = deriveTemporalRunId({
      kind: 'workflow',
      name: 'my-workflow',
      tenantId: 'tenant-b',
      idempotencyKey: 'shared-key',
    });

    expect(tenantA).not.toBe(tenantB);
  });

  test('deterministic ids are always 52 characters (run_ + 48 hex chars)', () => {
    const id = deriveTemporalRunId({
      kind: 'task',
      name: 'fixed-task',
      tenantId: 'fixed-tenant',
      idempotencyKey: 'fixed-key',
    });

    expect(id).toMatch(/^run_[0-9a-f]{48}$/);
    expect(id.length).toBe(52);
  });

  test('empty tenantId and empty string tenantId produce different ids', () => {
    const undefinedTenant = deriveTemporalRunId({
      kind: 'task',
      name: 'task',
      idempotencyKey: 'key',
    });
    const emptyStringTenant = deriveTemporalRunId({
      kind: 'task',
      name: 'task',
      tenantId: '',
      idempotencyKey: 'key',
    });

    // These should differ because the hash includes the empty string vs undefined
    expect(undefinedTenant).not.toBe(emptyStringTenant);
  });

  test('idempotencyKey is case sensitive in deterministic ids', () => {
    const upper = deriveTemporalRunId({
      kind: 'task',
      name: 'task',
      tenantId: 't',
      idempotencyKey: 'Key',
    });
    const lower = deriveTemporalRunId({
      kind: 'task',
      name: 'task',
      tenantId: 't',
      idempotencyKey: 'key',
    });

    expect(upper).not.toBe(lower);
  });

  test('long idempotencyKey values still produce valid ids', () => {
    const longKey = 'a'.repeat(1000);
    const id = deriveTemporalRunId({
      kind: 'task',
      name: 'long-key-task',
      tenantId: 't',
      idempotencyKey: longKey,
    });

    expect(id).toMatch(/^run_[0-9a-f]{48}$/);
    expect(id.length).toBe(52);
  });

  test('long task names still produce valid ids', () => {
    const longName = 'task-' + 'x'.repeat(500);
    const id = deriveTemporalRunId({
      kind: 'task',
      name: longName,
      tenantId: 't',
      idempotencyKey: 'k',
    });

    expect(id).toMatch(/^run_[0-9a-f]{48}$/);
    expect(id.length).toBe(52);
  });

  test('unique ids without idempotencyKey are still run_ prefixed', () => {
    for (let i = 0; i < 20; i++) {
      const id = deriveTemporalRunId({
        kind: 'task',
        name: 'my-task',
      });
      expect(id.startsWith('run_')).toBe(true);
    }
  });

  test('USE_EXISTING compatible: same inputs produce identical run ids', () => {
    // This is the property that makes USE_EXISTING work correctly:
    // identical inputs always produce the same workflow ID.
    const inputs = [
      { kind: 'task' as const, name: 'order-processing', idempotencyKey: 'invoice-999' },
      { kind: 'task' as const, name: 'order-processing', idempotencyKey: 'invoice-999' },
      { kind: 'task' as const, name: 'order-processing', idempotencyKey: 'invoice-999' },
    ];
    const ids = inputs.map(i => deriveTemporalRunId({ ...i, tenantId: 't1' }));

    expect(new Set(ids).size).toBe(1);
  });
});
