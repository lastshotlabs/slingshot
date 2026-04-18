import { describe, expect, test } from 'bun:test';
import type { PolicyInput, PolicyResolver } from '@lastshotlabs/slingshot-core';
import { definePolicyDispatch } from '../../src/policy/definePolicyDispatch';

function fakeInput(overrides?: Partial<PolicyInput>): PolicyInput {
  return {
    action: { kind: 'get' },
    userId: 'user-1',
    tenantId: 'tenant-1',
    record: null,
    input: null,
    c: {} as unknown as never,
    ...overrides,
  };
}

describe('definePolicyDispatch', () => {
  test('dispatches to matching handler', async () => {
    const resolver = definePolicyDispatch<unknown, unknown, 'chat' | 'thread'>({
      dispatch: input =>
        (input.record as { type: string } | null)?.type as 'chat' | 'thread' | undefined,
      handlers: {
        chat: () => Promise.resolve(true),
        thread: () => Promise.resolve(false),
      },
    });
    const chatResult = await resolver(fakeInput({ record: { type: 'chat' } }));
    expect(chatResult).toBe(true);

    const threadResult = await resolver(fakeInput({ record: { type: 'thread' } }));
    expect(threadResult).toBe(false);
  });

  test('fallback deny (default) for unknown key', async () => {
    const resolver = definePolicyDispatch<unknown, unknown, 'chat'>({
      dispatch: input => (input.record as { type: string } | null)?.type as 'chat' | undefined,
      handlers: {
        chat: () => Promise.resolve(true),
      },
    });
    const result = await resolver(fakeInput({ record: { type: 'unknown' } }));
    expect(result).toEqual(expect.objectContaining({ allow: false }));
  });

  test('fallback allow for unknown key', async () => {
    const resolver = definePolicyDispatch<unknown, unknown, 'chat'>({
      dispatch: input => (input.record as { type: string } | null)?.type as 'chat' | undefined,
      handlers: {
        chat: () => Promise.resolve(true),
      },
      fallback: 'allow',
    });
    const result = await resolver(fakeInput({ record: { type: 'unknown' } }));
    expect(result).toEqual({ allow: true });
  });

  test('fallback function for unknown key', async () => {
    const fallbackResolver: PolicyResolver = () =>
      Promise.resolve({ allow: false, reason: 'custom fallback' });
    const resolver = definePolicyDispatch<unknown, unknown, 'chat'>({
      dispatch: input => (input.record as { type: string } | null)?.type as 'chat' | undefined,
      handlers: {
        chat: () => Promise.resolve(true),
      },
      fallback: fallbackResolver,
    });
    const result = await resolver(fakeInput({ record: { type: 'unknown' } }));
    expect(result).toEqual({ allow: false, reason: 'custom fallback' });
  });

  test('undefined dispatch key triggers fallback', async () => {
    const resolver = definePolicyDispatch<unknown, unknown, 'chat'>({
      dispatch: () => undefined,
      handlers: {
        chat: () => Promise.resolve(true),
      },
    });
    const result = await resolver(fakeInput());
    expect(result).toEqual(expect.objectContaining({ allow: false }));
  });
});
