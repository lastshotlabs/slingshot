import { describe, expect, it } from 'bun:test';
import type { CompiledHandlerEntry } from '../../packages/slingshot-interactions/src/handlers/contracts';
import { dispatchInteraction } from '../../packages/slingshot-interactions/src/handlers/dispatch';
import type { DispatchRequest } from '../../packages/slingshot-interactions/src/routes/dispatchRoute.schema';

function buildRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    messageKind: 'community:thread',
    messageId: 'thread-1',
    actionId: 'community.publish:primary',
    ...overrides,
  };
}

function buildHandler(overrides: Partial<CompiledHandlerEntry> = {}): CompiledHandlerEntry {
  return {
    prefix: 'community.publish',
    template: {
      kind: 'queue',
      target: 'jobs.community.publish',
      fireAndForget: false,
    },
    dispatcher: {
      async dispatch() {
        return {
          status: 'ok',
          messageUpdate: {
            components: [
              {
                type: 'actionRow',
                children: [
                  {
                    type: 'button',
                    actionId: 'community.publish:primary',
                    label: 'Published',
                    disabled: true,
                  },
                ],
              },
            ],
          },
          body: { ok: true },
        };
      },
    },
    ...overrides,
  };
}

describe('dispatchInteraction', () => {
  it('updates the owning entity when a handler returns a valid message update', async () => {
    const updates: unknown[] = [];
    const handler = buildHandler();

    const outcome = await dispatchInteraction(
      {
        ctx: {} as never,
        handlers: {
          byPrefix: { [handler.prefix]: handler },
          sortedKeys: [handler.prefix],
          resolve() {
            return handler;
          },
        },
        evaluator: {
          async can() {
            return true;
          },
        } as never,
        rateLimit: {
          async trackAttempt() {
            return false;
          },
        } as never,
        peers: {
          chat: null,
          community: {
            peerKind: 'community',
            async resolveMessageByKindAndId() {
              return {
                id: 'thread-1',
                components: [
                  {
                    type: 'actionRow',
                    children: [
                      {
                        type: 'button',
                        actionId: 'community.publish:primary',
                        label: 'Publish',
                      },
                    ],
                  },
                ],
              };
            },
            async updateComponents(_kind, _id, components) {
              updates.push(components);
            },
          },
        },
        rateLimitWindowMs: 60_000,
        rateLimitMax: 20,
      },
      buildRequest(),
      'user-1',
      '',
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.httpStatus).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual([
      {
        type: 'actionRow',
        children: [
          {
            type: 'button',
            actionId: 'community.publish:primary',
            label: 'Published',
            disabled: true,
          },
        ],
      },
    ]);
  });

  it('returns forbidden when the component permission check fails', async () => {
    const handler = buildHandler();

    const outcome = await dispatchInteraction(
      {
        ctx: {} as never,
        handlers: {
          byPrefix: { [handler.prefix]: handler },
          sortedKeys: [handler.prefix],
          resolve() {
            return handler;
          },
        },
        evaluator: {
          async can() {
            return false;
          },
        } as never,
        rateLimit: {
          async trackAttempt() {
            return false;
          },
        } as never,
        peers: {
          chat: null,
          community: {
            peerKind: 'community',
            async resolveMessageByKindAndId() {
              return {
                id: 'thread-1',
                components: [
                  {
                    type: 'actionRow',
                    children: [
                      {
                        type: 'button',
                        actionId: 'community.publish:primary',
                        label: 'Publish',
                        permission: 'community:thread.publish',
                      },
                    ],
                  },
                ],
              };
            },
            async updateComponents() {
              throw new Error('should not update when forbidden');
            },
          },
        },
        rateLimitWindowMs: 60_000,
        rateLimitMax: 20,
      },
      buildRequest(),
      'user-1',
      '',
    );

    expect(outcome.status).toBe('forbidden');
    expect(outcome.httpStatus).toBe(403);
    expect(outcome.body).toEqual({
      error: 'permission denied',
      permission: 'community:thread.publish',
    });
  });
});
