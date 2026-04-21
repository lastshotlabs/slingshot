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
});
