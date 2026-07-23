import { describe, expect, test } from 'bun:test';
import { createUpdateMemberPreferencesHandler } from '../../../src/entities/runtime';
import type { ChatAdapterRefs } from '../../../src/entities/runtime';
import type { RoomMemberAdapter } from '../../../src/types';

describe('member preference operation', () => {
  test('updates only the authenticated actor membership', async () => {
    let updated: unknown;
    const members = {
      findMember: async ({ userId }: { userId: string }) => ({ id: 'm1', userId }),
      update: async (_id: string, input: unknown) => {
        updated = input;
        return { id: 'm1', ...(input as object) };
      },
    } as unknown as RoomMemberAdapter;
    const result = await createUpdateMemberPreferencesHandler({ members } as ChatAdapterRefs)({
      'actor.id': 'u1',
      roomId: 'r1',
      notifyOn: 'mentions',
    });
    expect(updated).toEqual({ notifyOn: 'mentions' });
    expect(result).toMatchObject({ id: 'm1', notifyOn: 'mentions' });
  });
});
