import { beforeEach, describe, expect, it } from 'bun:test';
import { createEntityFactories, defineOperations, op } from '@lastshotlabs/slingshot-entity';
import { defineEntity, field } from '../../packages/slingshot-core/src/entityConfig';

// ---------------------------------------------------------------------------
// Test entity
// ---------------------------------------------------------------------------

const Post = defineEntity('Post', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    title: field.string(),
    labelIds: field.json({ optional: true }),
    tags: field.json({ optional: true }),
  },
});

const PostOps = defineOperations(Post, {
  setLabels: op.arraySet({ field: 'labelIds', value: 'input:labelIds' }),
  setTags: op.arraySet({ field: 'tags', value: 'input:tags', dedupe: false }),
});

// ---------------------------------------------------------------------------
// Tests — memory backend
// ---------------------------------------------------------------------------

describe('op.arraySet (memory)', () => {
  const factories = createEntityFactories(Post, PostOps.operations);
  let adapter: ReturnType<typeof factories.memory>;

  beforeEach(async () => {
    adapter = factories.memory();
    await adapter.clear();
  });

  it('replaces an empty array with the incoming array', async () => {
    const post = await adapter.create({ title: 'Hello' } as any);
    const updated = await (adapter as any).setLabels(post.id, ['a', 'b', 'c']);
    expect(updated.labelIds).toEqual(['a', 'b', 'c']);
  });

  it('replaces a non-empty array completely', async () => {
    const post = await adapter.create({ title: 'Hello', labelIds: ['old'] } as any);
    const updated = await (adapter as any).setLabels(post.id, ['x', 'y']);
    expect(updated.labelIds).toEqual(['x', 'y']);
  });

  it('deduplicates by default (dedupe: true)', async () => {
    const post = await adapter.create({ title: 'Hello' } as any);
    const updated = await (adapter as any).setLabels(post.id, ['a', 'b', 'a', 'c', 'b']);
    expect(updated.labelIds).toEqual(['a', 'b', 'c']);
  });

  it('preserves insertion order when deduplicating', async () => {
    const post = await adapter.create({ title: 'Hello' } as any);
    const updated = await (adapter as any).setLabels(post.id, ['c', 'a', 'b', 'a', 'c']);
    expect(updated.labelIds).toEqual(['c', 'a', 'b']);
  });

  it('allows duplicates when dedupe: false', async () => {
    const post = await adapter.create({ title: 'Hello' } as any);
    const updated = await (adapter as any).setTags(post.id, ['a', 'b', 'a']);
    expect(updated.tags).toEqual(['a', 'b', 'a']);
  });

  it('sets to empty array', async () => {
    const post = await adapter.create({ title: 'Hello', labelIds: ['a', 'b'] } as any);
    const updated = await (adapter as any).setLabels(post.id, []);
    expect(updated.labelIds).toEqual([]);
  });

  it('throws when record is not found', async () => {
    expect((adapter as any).setLabels('nonexistent-id', ['a'])).rejects.toThrow('Not found');
  });

  it('throws when value is not an array', async () => {
    const post = await adapter.create({ title: 'Hello' } as any);
    expect((adapter as any).setLabels(post.id, 'not-an-array')).rejects.toThrow(
      'arraySet value must be an array',
    );
  });

  it('returns the full updated record', async () => {
    const post = await adapter.create({ title: 'My Post' } as any);
    const updated = await (adapter as any).setLabels(post.id, ['label-1']);
    expect(updated.id).toBe(post.id);
    expect(updated.title).toBe('My Post');
    expect(updated.labelIds).toEqual(['label-1']);
  });
});
