import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { auditLog, emitEvent, emitEventDynamic } from '../../src/afterHooks';
import { HandlerError, IdempotencyCacheHit, defineHandler } from '../../src/handler';

function createTestContext() {
  const emitted: Array<{ key: string; payload: unknown }> = [];
  const logEntry = mock(async (_entry: unknown) => {});

  return {
    ctx: {
      app: new Hono(),
      pluginState: new Map(),
      adapters: {},
      bus: {
        emit(key: string, payload: unknown) {
          emitted.push({ key, payload });
        },
      },
      persistence: {
        auditLog: { logEntry },
        idempotency: {
          get: mock(async () => null),
          set: mock(async () => {}),
        },
      },
    } as never,
    emitted,
    logEntry,
  };
}

const baseMeta = {
  requestId: 'req-1',
  tenantId: 'tenant-1',
  authUserId: 'user-1',
  correlationId: 'corr-1',
  ip: '127.0.0.1',
};

afterEach(() => {
  mock.restore();
});

describe('handler primitives and after hooks', () => {
  test('HandlerError captures status, code, and details', () => {
    const error = new HandlerError('Forbidden', {
      status: 403,
      code: 'forbidden',
      details: { reason: 'missing permission' },
    });

    expect(error.name).toBe('HandlerError');
    expect(error.status).toBe(403);
    expect(error.code).toBe('forbidden');
    expect(error.details).toEqual({ reason: 'missing permission' });
  });

  test('emitEvent and emitEventDynamic publish the expected payloads', async () => {
    const { ctx, emitted } = createTestContext();

    await emitEvent('items.created', {
      payload: ['id'],
      include: ['tenantId', 'actorId'],
    })({
      ctx,
      input: null,
      output: { id: 'item-1', ignored: true },
      handlerName: 'items.create',
      meta: baseMeta,
    });

    await emitEventDynamic(({ output }) => {
      const record = output as { id: string };
      return { key: 'items.dynamic', payload: { itemId: record.id } };
    })({
      ctx,
      input: null,
      output: { id: 'item-2' },
      handlerName: 'items.create',
      meta: baseMeta,
    });

    expect(emitted).toEqual([
      {
        key: 'items.created',
        payload: { id: 'item-1', tenantId: 'tenant-1', actorId: 'user-1' },
      },
      {
        key: 'items.dynamic',
        payload: { itemId: 'item-2' },
      },
    ]);
  });

  test('auditLog writes a structured audit entry', async () => {
    const { ctx, logEntry } = createTestContext();

    await auditLog('items.create')({
      ctx,
      input: { name: 'General' },
      output: { id: 'item-1' },
      handlerName: 'items.create',
      meta: baseMeta,
    });

    expect(logEntry).toHaveBeenCalledTimes(1);
    expect(logEntry.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-1',
      tenantId: 'tenant-1',
      method: 'HANDLER',
      path: 'items.create',
      status: 200,
      action: 'items.create',
      requestId: 'req-1',
      meta: {
        input: { name: 'General' },
        output: { id: 'item-1' },
      },
    });
  });

  test('defineHandler returns cached output from IdempotencyCacheHit', async () => {
    const { ctx } = createTestContext();
    const handle = mock(async () => ({ id: 'live' }));

    const handler = defineHandler({
      name: 'items.cached',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      guards: [
        async () => {
          throw new IdempotencyCacheHit({ id: 'cached' });
        },
      ],
      handle,
    });

    const result = await handler.invoke({ id: 'item-1' }, { ctx });
    expect(result).toEqual({ id: 'cached' });
    expect(handle).not.toHaveBeenCalled();
  });

  test('defineHandler logs and swallows after-hook failures', async () => {
    const { ctx } = createTestContext();
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});

    const handler = defineHandler({
      name: 'items.after',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      after: [
        async () => {
          throw new Error('after hook boom');
        },
      ],
      handle: async ({ input }) => ({ id: input.id }),
    });

    await expect(handler.invoke({ id: 'item-1' }, { ctx })).resolves.toEqual({
      id: 'item-1',
    });
    expect(consoleError).toHaveBeenCalled();
  });
});
