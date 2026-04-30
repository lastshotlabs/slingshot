import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { SlingshotContext } from '../../src/context/slingshotContext';
import { ValidationError } from '../../src/errors';
import {
  type AfterHook,
  type Guard,
  type GuardWithMetadata,
  type HandlerArgs,
  HandlerError,
  type HandlerMeta,
  IdempotencyCacheHit,
  type InvokeOpts,
  defineHandler,
  resolveActor,
} from '../../src/handler';
import { ANONYMOUS_ACTOR } from '../../src/identity';
import type { Logger } from '../../src/observability/logger';

/** Minimal stub for SlingshotContext — only what the handler pipeline accesses. */
const stubCtx = {} as SlingshotContext;

function makeOpts(meta?: Partial<HandlerMeta>): InvokeOpts {
  return { ctx: stubCtx, meta };
}

/** Capture logger that records calls for assertions. */
function createCapturingLogger(): Logger & {
  errors: Array<{ msg: string; fields?: Record<string, unknown> }>;
} {
  const errors: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  return {
    errors,
    debug() {},
    info() {},
    warn() {},
    error(msg: string, fields?: Record<string, unknown>) {
      errors.push({ msg, fields });
    },
    child() {
      return this;
    },
  };
}

// -------------------------------------------------------------------------
// resolveActor
// -------------------------------------------------------------------------

describe('resolveActor', () => {
  test('returns the actor from HandlerMeta', () => {
    const actor = { ...ANONYMOUS_ACTOR, id: 'usr_1', kind: 'user' as const };
    const meta: HandlerMeta = {
      requestId: 'r1',
      actor,
      requestTenantId: null,
      correlationId: 'r1',
      ip: null,
    };
    expect(resolveActor(meta)).toBe(actor);
  });
});

// -------------------------------------------------------------------------
// HandlerError
// -------------------------------------------------------------------------

describe('HandlerError', () => {
  test('defaults to status 500', () => {
    const err = new HandlerError('boom');
    expect(err.status).toBe(500);
    expect(err.message).toBe('boom');
    expect(err.name).toBe('HandlerError');
  });

  test('accepts custom status, code, and details', () => {
    const err = new HandlerError('not found', {
      status: 404,
      code: 'NOT_FOUND',
      details: { id: '123' },
    });
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.details).toEqual({ id: '123' });
  });
});

// -------------------------------------------------------------------------
// IdempotencyCacheHit
// -------------------------------------------------------------------------

describe('IdempotencyCacheHit', () => {
  test('stores cachedOutput and has correct name', () => {
    const hit = new IdempotencyCacheHit({ id: 'cached' });
    expect(hit.cachedOutput).toEqual({ id: 'cached' });
    expect(hit.name).toBe('IdempotencyCacheHit');
    expect(hit.message).toBe('Idempotency cache hit');
  });
});

// -------------------------------------------------------------------------
// Input validation
// -------------------------------------------------------------------------

describe('defineHandler – input validation', () => {
  const handler = defineHandler({
    name: 'testInput',
    input: z.object({ name: z.string(), age: z.number().int().positive() }),
    output: z.object({ ok: z.boolean() }),
    handle: () => ({ ok: true }),
  });

  test('valid input passes through', async () => {
    const result = await handler.invoke({ name: 'Alice', age: 30 }, makeOpts());
    expect(result).toEqual({ ok: true });
  });

  test('invalid input throws ValidationError', async () => {
    await expect(handler.invoke({ name: 123, age: -1 }, makeOpts())).rejects.toThrow(
      ValidationError,
    );
  });

  test('missing required field throws ValidationError', async () => {
    await expect(handler.invoke({ name: 'Bob' }, makeOpts())).rejects.toThrow(ValidationError);
  });
});

// -------------------------------------------------------------------------
// Output validation
// -------------------------------------------------------------------------

describe('defineHandler – output validation', () => {
  test('valid output is returned', async () => {
    const handler = defineHandler({
      name: 'testOutputOk',
      input: z.object({}),
      output: z.object({ id: z.string() }),
      handle: () => ({ id: 'abc' }),
    });
    const result = await handler.invoke({}, makeOpts());
    expect(result).toEqual({ id: 'abc' });
  });

  test('invalid output throws ValidationError', async () => {
    const handler = defineHandler({
      name: 'testOutputBad',
      input: z.object({}),
      output: z.object({ id: z.string() }),
      handle: () => ({ id: 42 }) as never,
    });
    await expect(handler.invoke({}, makeOpts())).rejects.toThrow(ValidationError);
  });
});

// -------------------------------------------------------------------------
// Guard pipeline
// -------------------------------------------------------------------------

describe('defineHandler – guards', () => {
  test('single guard passes', async () => {
    const guardFn = mock(() => {});
    const handler = defineHandler({
      name: 'guardPass',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [guardFn],
      handle: () => ({ ok: true }),
    });
    const result = await handler.invoke({}, makeOpts());
    expect(result).toEqual({ ok: true });
    expect(guardFn).toHaveBeenCalledTimes(1);
  });

  test('multiple guards execute in order', async () => {
    const order: number[] = [];
    const guard1: Guard = () => {
      order.push(1);
    };
    const guard2: Guard = () => {
      order.push(2);
    };
    const guard3: Guard = () => {
      order.push(3);
    };
    const handler = defineHandler({
      name: 'guardOrder',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [guard1, guard2, guard3],
      handle: () => ({ ok: true }),
    });
    await handler.invoke({}, makeOpts());
    expect(order).toEqual([1, 2, 3]);
  });

  test('guard failure prevents handler execution', async () => {
    const handleFn = mock(() => ({ ok: true }));
    const handler = defineHandler({
      name: 'guardFail',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [
        () => {
          throw new HandlerError('Forbidden', { status: 403 });
        },
      ],
      handle: handleFn,
    });
    await expect(handler.invoke({}, makeOpts())).rejects.toThrow(HandlerError);
    expect(handleFn).not.toHaveBeenCalled();
  });

  test('guard failure stops subsequent guards', async () => {
    const secondGuard = mock(() => {});
    const handler = defineHandler({
      name: 'guardStops',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [
        () => {
          throw new HandlerError('Unauthorized', { status: 401 });
        },
        secondGuard,
      ],
      handle: () => ({ ok: true }),
    });
    await expect(handler.invoke({}, makeOpts())).rejects.toThrow(HandlerError);
    expect(secondGuard).not.toHaveBeenCalled();
  });

  test('async guard is awaited', async () => {
    let guardRan = false;
    const handler = defineHandler({
      name: 'asyncGuard',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [
        async () => {
          await new Promise(resolve => setTimeout(resolve, 1));
          guardRan = true;
        },
      ],
      handle: () => ({ ok: true }),
    });
    await handler.invoke({}, makeOpts());
    expect(guardRan).toBe(true);
  });

  test('guard receives correct HandlerArgs', async () => {
    let capturedArgs: HandlerArgs | null = null;
    const handler = defineHandler({
      name: 'guardArgs',
      input: z.object({ x: z.number() }),
      output: z.object({ ok: z.boolean() }),
      guards: [
        args => {
          capturedArgs = args;
        },
      ],
      handle: () => ({ ok: true }),
    });
    await handler.invoke({ x: 42 }, makeOpts({ requestId: 'req-1' }));
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.input).toEqual({ x: 42 });
    expect(capturedArgs!.handlerName).toBe('guardArgs');
    expect(capturedArgs!.meta.requestId).toBe('req-1');
  });
});

// -------------------------------------------------------------------------
// Idempotency cache hit
// -------------------------------------------------------------------------

describe('defineHandler – idempotency cache hit', () => {
  test('IdempotencyCacheHit from guard returns cached output', async () => {
    const handler = defineHandler({
      name: 'idempotent',
      input: z.object({}),
      output: z.object({ id: z.string() }),
      guards: [
        () => {
          throw new IdempotencyCacheHit({ id: 'cached-123' });
        },
      ],
      handle: () => ({ id: 'new-456' }),
    });
    const result = await handler.invoke({}, makeOpts());
    expect(result).toEqual({ id: 'cached-123' });
  });

  test('IdempotencyCacheHit validates cached output against output schema', async () => {
    const handler = defineHandler({
      name: 'idempotentBadCache',
      input: z.object({}),
      output: z.object({ id: z.string() }),
      guards: [
        () => {
          throw new IdempotencyCacheHit({ id: 999 }); // wrong type
        },
      ],
      handle: () => ({ id: 'new' }),
    });
    await expect(handler.invoke({}, makeOpts())).rejects.toThrow(ValidationError);
  });

  test('handler is not called when idempotency cache hits', async () => {
    const handleFn = mock(() => ({ ok: true }));
    const handler = defineHandler({
      name: 'idempotentSkip',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [
        () => {
          throw new IdempotencyCacheHit({ ok: true });
        },
      ],
      handle: handleFn,
    });
    await handler.invoke({}, makeOpts());
    expect(handleFn).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// After hooks
// -------------------------------------------------------------------------

describe('defineHandler – after hooks', () => {
  test('after hooks run after handler', async () => {
    const order: string[] = [];
    const handler = defineHandler({
      name: 'afterOrder',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      after: [
        () => {
          order.push('after');
        },
      ],
      handle: () => {
        order.push('handle');
        return { ok: true };
      },
    });
    await handler.invoke({}, makeOpts());
    expect(order).toEqual(['handle', 'after']);
  });

  test('after hook receives output', async () => {
    let capturedOutput: unknown = null;
    const handler = defineHandler({
      name: 'afterOutput',
      input: z.object({}),
      output: z.object({ id: z.string() }),
      after: [
        args => {
          capturedOutput = args.output;
        },
      ],
      handle: () => ({ id: 'abc' }),
    });
    await handler.invoke({}, makeOpts());
    expect(capturedOutput).toEqual({ id: 'abc' });
  });

  test('after hook failure is logged, not thrown', async () => {
    const logger = createCapturingLogger();
    const handler = defineHandler({
      name: 'afterFail',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      logger,
      after: [
        () => {
          throw new Error('after-hook-boom');
        },
      ],
      handle: () => ({ ok: true }),
    });
    // Should not throw despite after hook failure
    const result = await handler.invoke({}, makeOpts());
    expect(result).toEqual({ ok: true });
    expect(logger.errors.length).toBe(1);
    expect(logger.errors[0].msg).toBe('After hook failed');
    expect(logger.errors[0].fields?.handler).toBe('afterFail');
    expect(logger.errors[0].fields?.error).toBe('after-hook-boom');
  });

  test('after hook failure without logger does not throw', async () => {
    const handler = defineHandler({
      name: 'afterFailNoLogger',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      // no logger
      after: [
        () => {
          throw new Error('silent-fail');
        },
      ],
      handle: () => ({ ok: true }),
    });
    const result = await handler.invoke({}, makeOpts());
    expect(result).toEqual({ ok: true });
  });

  test('multiple after hooks run in order', async () => {
    const order: number[] = [];
    const handler = defineHandler({
      name: 'afterMultiple',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      after: [
        () => {
          order.push(1);
        },
        () => {
          order.push(2);
        },
      ],
      handle: () => ({ ok: true }),
    });
    await handler.invoke({}, makeOpts());
    expect(order).toEqual([1, 2]);
  });

  test('guard with _afterHook has its hook collected and run', async () => {
    const afterFromGuard = mock(() => {});
    const guardWithHook: GuardWithMetadata = Object.assign((() => {}) as Guard, {
      _afterHook: afterFromGuard as AfterHook,
    });
    const handler = defineHandler({
      name: 'guardAfterHook',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [guardWithHook],
      handle: () => ({ ok: true }),
    });
    await handler.invoke({}, makeOpts());
    expect(afterFromGuard).toHaveBeenCalledTimes(1);
  });

  test('explicit after hooks run before guard-paired after hooks', async () => {
    const order: string[] = [];
    const guardWithHook: GuardWithMetadata = Object.assign((() => {}) as Guard, {
      _afterHook: (() => {
        order.push('guard-after');
      }) as AfterHook,
    });
    const handler = defineHandler({
      name: 'afterHookOrder',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [guardWithHook],
      after: [
        () => {
          order.push('explicit-after');
        },
      ],
      handle: () => ({ ok: true }),
    });
    await handler.invoke({}, makeOpts());
    expect(order).toEqual(['explicit-after', 'guard-after']);
  });
});

// -------------------------------------------------------------------------
// Error propagation
// -------------------------------------------------------------------------

describe('defineHandler – error propagation', () => {
  test('handler error propagates as-is', async () => {
    const handler = defineHandler({
      name: 'handleError',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handle: () => {
        throw new HandlerError('internal', { status: 500, code: 'INTERNAL' });
      },
    });
    try {
      await handler.invoke({}, makeOpts());
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(HandlerError);
      expect((err as HandlerError).status).toBe(500);
      expect((err as HandlerError).code).toBe('INTERNAL');
    }
  });

  test('generic error from handler propagates', async () => {
    const handler = defineHandler({
      name: 'genericError',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handle: () => {
        throw new Error('unexpected');
      },
    });
    await expect(handler.invoke({}, makeOpts())).rejects.toThrow('unexpected');
  });

  test('non-IdempotencyCacheHit error from guard propagates', async () => {
    const handler = defineHandler({
      name: 'guardGenericError',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [
        () => {
          throw new Error('guard-fail');
        },
      ],
      handle: () => ({ ok: true }),
    });
    await expect(handler.invoke({}, makeOpts())).rejects.toThrow('guard-fail');
  });
});

// -------------------------------------------------------------------------
// Full pipeline end-to-end
// -------------------------------------------------------------------------

describe('defineHandler – full pipeline', () => {
  test('complete pipeline: input validation -> guards -> handle -> output validation -> after hooks', async () => {
    const order: string[] = [];
    const logger = createCapturingLogger();

    const handler = defineHandler({
      name: 'fullPipeline',
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      logger,
      guards: [
        args => {
          order.push('guard');
          if (args.input.x < 0) throw new HandlerError('negative', { status: 400 });
        },
      ],
      after: [
        () => {
          order.push('after');
        },
      ],
      handle: args => {
        order.push('handle');
        return { result: args.input.x * 2 };
      },
    });

    const result = await handler.invoke({ x: 5 }, makeOpts());
    expect(result).toEqual({ result: 10 });
    expect(order).toEqual(['guard', 'handle', 'after']);
  });

  test('handler instance is frozen', () => {
    const handler = defineHandler({
      name: 'frozen',
      input: z.object({}),
      output: z.object({}),
      handle: () => ({}),
    });
    expect(Object.isFrozen(handler)).toBe(true);
    expect(Object.isFrozen(handler.guards)).toBe(true);
    expect(Object.isFrozen(handler.after)).toBe(true);
  });

  test('default meta fills in requestId and anonymous actor', async () => {
    let capturedMeta: HandlerMeta | null = null;
    const handler = defineHandler({
      name: 'defaultMeta',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [
        args => {
          capturedMeta = args.meta;
        },
      ],
      handle: () => ({ ok: true }),
    });
    await handler.invoke({}, makeOpts());
    expect(capturedMeta).not.toBeNull();
    expect(capturedMeta!.requestId).toBeTruthy();
    expect(capturedMeta!.actor).toEqual(ANONYMOUS_ACTOR);
    expect(capturedMeta!.correlationId).toBe(capturedMeta!.requestId);
    expect(capturedMeta!.ip).toBeNull();
  });

  test('custom meta fields are respected', async () => {
    let capturedMeta: HandlerMeta | null = null;
    const handler = defineHandler({
      name: 'customMeta',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [
        args => {
          capturedMeta = args.meta;
        },
      ],
      handle: () => ({ ok: true }),
    });
    await handler.invoke(
      {},
      makeOpts({
        requestId: 'custom-id',
        ip: '1.2.3.4',
        idempotencyKey: 'idem-1',
        method: 'POST',
        path: '/api/test',
      }),
    );
    expect(capturedMeta!.requestId).toBe('custom-id');
    expect(capturedMeta!.ip).toBe('1.2.3.4');
    expect(capturedMeta!.idempotencyKey).toBe('idem-1');
    expect(capturedMeta!.method).toBe('POST');
    expect(capturedMeta!.path).toBe('/api/test');
  });
});
