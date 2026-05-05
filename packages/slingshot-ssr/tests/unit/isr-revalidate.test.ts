import { describe, expect, it, mock } from 'bun:test';
import { createIsrInvalidators } from '../../src/isr/revalidate';
import type { IsrCacheAdapter } from '../../src/isr/types';

function makeAdapter(): { adapter: IsrCacheAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter: IsrCacheAdapter = {
    get: mock(async () => null),
    set: mock(async () => {}),
    invalidatePath: mock(async (path: string) => {
      calls.push(`invalidatePath:${path}`);
    }),
    invalidateTag: mock(async (tag: string) => {
      calls.push(`invalidateTag:${tag}`);
    }),
  };
  return { adapter, calls };
}

describe('createIsrInvalidators', () => {
  it('revalidatePath delegates to cache.invalidatePath', async () => {
    const { adapter, calls } = makeAdapter();
    const invalidators = createIsrInvalidators(adapter);

    await invalidators.revalidatePath('/posts');

    expect(calls).toEqual(['invalidatePath:/posts']);
  });

  it('revalidateTag delegates to cache.invalidateTag', async () => {
    const { adapter, calls } = makeAdapter();
    const invalidators = createIsrInvalidators(adapter);

    await invalidators.revalidateTag('posts');

    expect(calls).toEqual(['invalidateTag:posts']);
  });

  it('forwards the exact path string to invalidatePath', async () => {
    const { adapter, calls } = makeAdapter();
    const invalidators = createIsrInvalidators(adapter);

    await invalidators.revalidatePath('/blog/nba-finals-2025');

    expect(calls).toEqual(['invalidatePath:/blog/nba-finals-2025']);
  });

  it('forwards the exact tag string to invalidateTag', async () => {
    const { adapter, calls } = makeAdapter();
    const invalidators = createIsrInvalidators(adapter);

    await invalidators.revalidateTag('post:abc123');

    expect(calls).toEqual(['invalidateTag:post:abc123']);
  });

  it('does not call invalidateTag when revalidatePath is called', async () => {
    const { adapter } = makeAdapter();
    const invalidators = createIsrInvalidators(adapter);

    await invalidators.revalidatePath('/posts');

    expect(adapter.invalidateTag).not.toHaveBeenCalled();
  });

  it('does not call invalidatePath when revalidateTag is called', async () => {
    const { adapter } = makeAdapter();
    const invalidators = createIsrInvalidators(adapter);

    await invalidators.revalidateTag('posts');

    expect(adapter.invalidatePath).not.toHaveBeenCalled();
  });

  it('returns a promise from revalidatePath', async () => {
    const { adapter } = makeAdapter();
    const invalidators = createIsrInvalidators(adapter);

    const result = invalidators.revalidatePath('/foo');

    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('returns a promise from revalidateTag', async () => {
    const { adapter } = makeAdapter();
    const invalidators = createIsrInvalidators(adapter);

    const result = invalidators.revalidateTag('foo');

    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('creates independent invalidator objects bound to their own adapter', async () => {
    const a = makeAdapter();
    const b = makeAdapter();

    const invA = createIsrInvalidators(a.adapter);
    const invB = createIsrInvalidators(b.adapter);

    await invA.revalidatePath('/a');
    await invB.revalidateTag('b-tag');

    expect(a.calls).toEqual(['invalidatePath:/a']);
    expect(b.calls).toEqual(['invalidateTag:b-tag']);
  });
});
