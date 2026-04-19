import { describe, expect, test } from 'bun:test';
import { createCommunityTestAdapters } from '../../src/testing';

describe('createCommunityTestAdapters', () => {
  test('creates working in-memory adapters and clear resets stored entities', async () => {
    const adapters = createCommunityTestAdapters();
    const created = await adapters.containers.create({
      slug: 'general',
      name: 'General',
      createdBy: 'user-1',
    } as never);

    const loaded = await adapters.containers.getById(created.id);
    expect(loaded?.slug).toBe('general');

    await adapters.clear();

    expect(await adapters.containers.getById(created.id)).toBeNull();
  });
});
