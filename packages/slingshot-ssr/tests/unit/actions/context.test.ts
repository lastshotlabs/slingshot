// packages/slingshot-ssr/tests/unit/actions/context.test.ts
// Unit tests for packages/slingshot-ssr/src/actions/context.ts
//
// Tests cover:
// - revalidatePath() delegates to the injected implementation
// - revalidateTag() delegates to the injected implementation
// - Calling revalidatePath() / revalidateTag() outside withActionContext() throws
// - withActionContext() isolates state between concurrent action invocations
import { describe, expect, it, vi } from 'vitest';
import { revalidatePath, revalidateTag, withActionContext } from '../../../src/actions/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx() {
  return {
    revalidatePath: vi.fn(async () => undefined),
    revalidateTag: vi.fn(async () => undefined),
  };
}

// ─── withActionContext + revalidatePath ───────────────────────────────────────

describe('withActionContext / revalidatePath', () => {
  it('delegates to the injected revalidatePath implementation', async () => {
    const ctx = makeCtx();
    await withActionContext(ctx, async () => {
      await revalidatePath('/posts');
    });
    expect(ctx.revalidatePath).toHaveBeenCalledOnce();
    expect(ctx.revalidatePath).toHaveBeenCalledWith('/posts');
  });

  it('returns the return value of the wrapped function', async () => {
    const ctx = makeCtx();
    const result = await withActionContext(ctx, async () => {
      return 'action-result';
    });
    expect(result).toBe('action-result');
  });
});

// ─── withActionContext + revalidateTag ────────────────────────────────────────

describe('withActionContext / revalidateTag', () => {
  it('delegates to the injected revalidateTag implementation', async () => {
    const ctx = makeCtx();
    await withActionContext(ctx, async () => {
      await revalidateTag('posts');
      await revalidateTag('post:abc123');
    });
    expect(ctx.revalidateTag).toHaveBeenCalledTimes(2);
    expect(ctx.revalidateTag).toHaveBeenNthCalledWith(1, 'posts');
    expect(ctx.revalidateTag).toHaveBeenNthCalledWith(2, 'post:abc123');
  });
});

// ─── Outside-context guards ───────────────────────────────────────────────────

describe('revalidatePath() / revalidateTag() outside context', () => {
  it('revalidatePath() throws when called outside withActionContext()', async () => {
    await expect(revalidatePath('/posts')).rejects.toThrow(
      '[slingshot-ssr] revalidatePath() called outside of a server action context',
    );
  });

  it('revalidateTag() throws when called outside withActionContext()', async () => {
    await expect(revalidateTag('posts')).rejects.toThrow(
      '[slingshot-ssr] revalidateTag() called outside of a server action context',
    );
  });
});

// ─── Context isolation ────────────────────────────────────────────────────────

describe('concurrent action context isolation', () => {
  it('each withActionContext() invocation has its own isolated context', async () => {
    const ctxA = makeCtx();
    const ctxB = makeCtx();

    const actionA = withActionContext(ctxA, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      await revalidatePath('/from-a');
    });

    const actionB = withActionContext(ctxB, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      await revalidatePath('/from-b');
    });

    await Promise.all([actionA, actionB]);

    // Each context's implementation called only by its own action
    expect(ctxA.revalidatePath).toHaveBeenCalledWith('/from-a');
    expect(ctxA.revalidatePath).not.toHaveBeenCalledWith('/from-b');

    expect(ctxB.revalidatePath).toHaveBeenCalledWith('/from-b');
    expect(ctxB.revalidatePath).not.toHaveBeenCalledWith('/from-a');
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe('error propagation', () => {
  it('propagates errors thrown by the injected revalidatePath implementation', async () => {
    const ctx = {
      revalidatePath: vi.fn(async () => {
        throw new Error('cache write failed');
      }),
      revalidateTag: vi.fn(async () => undefined),
    };

    await expect(
      withActionContext(ctx, async () => {
        await revalidatePath('/posts');
      }),
    ).rejects.toThrow('cache write failed');
  });

  it('propagates errors thrown by the wrapped action function', async () => {
    const ctx = makeCtx();
    await expect(
      withActionContext(ctx, async () => {
        throw new Error('action failed');
      }),
    ).rejects.toThrow('action failed');
  });
});
