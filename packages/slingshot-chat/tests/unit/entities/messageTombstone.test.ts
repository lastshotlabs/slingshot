import { describe, expect, test } from 'bun:test';
import { applyMessageTombstoneTransform } from '../../../src/entities/runtime';
import type { MessageAdapter } from '../../../src/types';

describe('message tombstone transform', () => {
  test('blanks mutable content while retaining the message row', async () => {
    let update: Record<string, unknown> | undefined;
    const adapter = {
      getById: async () => ({ id: 'm1', roomId: 'r1', body: 'secret' }),
      update: async (_id: string, input: Record<string, unknown>) => { update = input; return { id: 'm1', roomId: 'r1', ...input }; },
    } as unknown as MessageAdapter;
    const transformed = applyMessageTombstoneTransform(adapter) as unknown as MessageAdapter;
    expect(await transformed.delete('m1')).toBe(true);
    expect(update).toMatchObject({ body: '', attachments: [], embeds: [], appMetadata: null });
    expect(typeof update?.deletedAt).toBe('string');
  });

  test('returns false without updating when the row is absent', async () => {
    let updated = false;
    const adapter = { getById: async () => null, update: async () => { updated = true; return null; } } as unknown as MessageAdapter;
    const transformed = applyMessageTombstoneTransform(adapter) as unknown as MessageAdapter;
    expect(await transformed.delete('missing')).toBe(false);
    expect(updated).toBe(false);
  });
});
