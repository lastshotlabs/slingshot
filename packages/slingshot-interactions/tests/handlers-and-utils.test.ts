import { describe, expect, mock, test } from 'bun:test';
import { InProcessAdapter, createRouter } from '@lastshotlabs/slingshot-core';
import { compileHandlers, dispatchInteraction, validateComponentTree } from '../src';
import {
  buildTestActionRow,
  buildTestButton,
  buildTestInteractionEvent,
  createFakeDispatcher,
} from '../src/testing';

function createDispatchDeps(overrides?: {
  peer?: {
    resolveMessageByKindAndId: (kind: string, id: string) => Promise<unknown>;
    updateComponents: (kind: string, id: string, components: unknown) => Promise<void>;
  } | null;
  can?: boolean;
  exceeded?: boolean;
  handler?: ReturnType<typeof createFakeDispatcher> | null;
  handlerKind?: 'webhook' | 'route' | 'queue';
}) {
  const updateComponents = mock(async () => {});
  const peer =
    overrides?.peer === undefined
      ? {
          async resolveMessageByKindAndId() {
            return {
              components: [
                {
                  type: 'actionRow',
                  children: [
                    {
                      type: 'button',
                      actionId: 'test:approve',
                      label: 'Approve',
                      permission: 'interactions.approve',
                    },
                  ],
                },
              ],
            };
          },
          updateComponents,
        }
      : overrides.peer;

  const dispatcher =
    overrides && 'handler' in overrides
      ? overrides.handler
      : createFakeDispatcher(async () => ({
          status: 'ok',
          message: 'handled',
          body: { ok: true },
        }));

  return {
    deps: {
      handlers: {
        byPrefix: {},
        sortedKeys: ['test:'],
        resolve(actionId: string) {
          if (actionId.startsWith('test:') && dispatcher) {
            return {
              prefix: 'test:',
              template: { kind: overrides?.handlerKind ?? 'queue', target: 'jobs:test' } as any,
              dispatcher,
            };
          }
          return null;
        },
      },
      evaluator: {
        can: async () => overrides?.can ?? true,
      },
      rateLimit: {
        trackAttempt: async () => overrides?.exceeded ?? false,
        resetAttempts: async () => {},
      },
      peers: {
        chat: peer as any,
        community: null,
      },
      rateLimitWindowMs: 30_000,
      rateLimitMax: 3,
    },
    updateComponents,
  };
}

describe('compileHandlers', () => {
  test('resolves the longest matching prefix first and returns null when unmatched', () => {
    const handlers = compileHandlers(
      {
        'jobs:': { kind: 'queue', target: 'jobs:interactions', fireAndForget: true },
        'jobs:approve:': { kind: 'queue', target: 'jobs:approvals', fireAndForget: true },
        'chat:react:': { kind: 'route', target: '/chat/reactions', timeoutMs: 5000 },
      },
      {
        app: createRouter(),
        bus: new InProcessAdapter(),
      },
    );

    expect(handlers.sortedKeys).toEqual(['jobs:approve:', 'chat:react:', 'jobs:']);
    expect(handlers.resolve('jobs:approve:42')?.prefix).toBe('jobs:approve:');
    expect(handlers.resolve('jobs:enqueue:42')?.prefix).toBe('jobs:');
    expect(handlers.resolve('missing:action')).toBeNull();
  });
});

describe('dispatchInteraction', () => {
  const request = {
    messageKind: 'chat:message' as const,
    messageId: 'msg-1',
    actionId: 'test:approve',
  };

  test('returns 503 when the peer for the message kind is not installed', async () => {
    const { deps } = createDispatchDeps({ peer: null });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(503);
    expect(outcome.status).toBe('error');
    expect(outcome.handlerKind).toBe('none');
  });

  test('returns 404 when the message cannot be resolved', async () => {
    const { deps } = createDispatchDeps({
      peer: {
        async resolveMessageByKindAndId() {
          return null;
        },
        async updateComponents() {},
      },
    });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(404);
    expect(outcome.status).toBe('notFound');
  });

  test('returns 404 for stale or invalid component trees', async () => {
    const { deps } = createDispatchDeps({
      peer: {
        async resolveMessageByKindAndId() {
          return { components: [{ bad: 'shape' }] };
        },
        async updateComponents() {},
      },
    });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(404);
    expect(outcome.errorDetail).toContain('schema parse');
  });

  test('returns 403 when a component permission check fails', async () => {
    const { deps } = createDispatchDeps({ can: false });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(403);
    expect(outcome.status).toBe('forbidden');
  });

  test('returns 429 when the interaction is rate limited', async () => {
    const { deps } = createDispatchDeps({ exceeded: true, can: true });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(429);
    expect(outcome.status).toBe('rateLimited');
  });

  test('returns 404 when no handler is registered for the action prefix', async () => {
    const { deps } = createDispatchDeps({ handler: null, can: true });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(404);
    expect(outcome.status).toBe('notFound');
  });

  test('returns 504 when the dispatcher throws a timeout error', async () => {
    const { deps } = createDispatchDeps({
      handlerKind: 'webhook',
      handler: createFakeDispatcher(async () => {
        throw new Error('request timeout');
      }),
    });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(504);
    expect(outcome.status).toBe('timeout');
    expect(outcome.handlerKind).toBe('webhook');
  });

  test('returns 502 when the dispatcher returns invalid component updates', async () => {
    const { deps } = createDispatchDeps({
      handlerKind: 'route',
      handler: createFakeDispatcher(async () => ({
        status: 'ok',
        messageUpdate: {
          components: [{ invalid: true }],
        },
      })),
    });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(502);
    expect(outcome.errorDetail).toContain('messageUpdate.components');
  });

  test('returns 502 when the dispatcher returns an invalid modal payload', async () => {
    const { deps } = createDispatchDeps({
      handlerKind: 'route',
      handler: createFakeDispatcher(async () => ({
        status: 'ok',
        modal: { title: 'Bad modal', components: [] },
      })),
    });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(502);
    expect(outcome.errorDetail).toContain('modal failed schema parse');
  });

  test('updates message components and returns 200 for successful handlers', async () => {
    const nextComponents = [
      buildTestActionRow({ children: [buildTestButton({ actionId: 'next:1' })] }),
    ];
    const { deps, updateComponents } = createDispatchDeps({
      can: true,
      exceeded: false,
      handlerKind: 'queue',
      handler: createFakeDispatcher(async () => ({
        status: 'ok',
        body: { updated: true },
        messageUpdate: { components: nextComponents },
      })),
    });

    const outcome = await dispatchInteraction(deps as any, request, 'user-1', 'tenant-1');

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.status).toBe('ok');
    expect(outcome.handlerKind).toBe('queue');
    expect(updateComponents).toHaveBeenCalledWith('chat:message', 'msg-1', nextComponents);
  });
});

describe('interaction testing helpers', () => {
  test('validateComponentTree accepts valid trees and rejects invalid buttons', () => {
    const validTree = [buildTestActionRow()];

    expect(validateComponentTree(validTree)).toEqual(validTree);
    expect(() =>
      validateComponentTree([
        {
          type: 'actionRow',
          children: [{ type: 'button', label: 'Broken' }],
        },
      ]),
    ).toThrow();
  });

  test('testing helpers build fixtures and fake dispatchers consistently', async () => {
    const event = buildTestInteractionEvent({ actionId: 'custom:click' });
    const dispatcher = createFakeDispatcher(async payload => ({
      status: 'ok',
      body: { actionId: payload.actionId },
    }));

    expect(buildTestButton()).toMatchObject({ type: 'button', actionId: 'test:click' });
    expect(event.actionId).toBe('custom:click');
    await expect(
      dispatcher.dispatch({
        actionId: 'helper:test',
        messageKind: 'chat:message',
        messageId: 'msg-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
      }),
    ).resolves.toEqual({
      status: 'ok',
      body: { actionId: 'helper:test' },
    });
  });
});
