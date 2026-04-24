import { describe, expect, test } from 'bun:test';
import {
  ANONYMOUS_ACTOR,
  type Actor,
  type HandlerMeta,
  type SlingshotContext,
} from '@lastshotlabs/slingshot-core';
import { invokeWithRecordIdempotency } from '../src/idempotency';

function createContext(): SlingshotContext {
  const store = new Map<
    string,
    { response: string; status: number; ttl: number; requestFingerprint?: string }
  >();

  return {
    persistence: {
      idempotency: {
        async get(key: string) {
          return store.get(key) ?? null;
        },
        async set(
          key: string,
          response: string,
          status: number,
          ttl: number,
          options?: { requestFingerprint?: string },
        ) {
          store.set(key, {
            response,
            status,
            ttl,
            requestFingerprint: options?.requestFingerprint,
          });
        },
      },
    },
  } as unknown as SlingshotContext;
}

function createMeta(overrides?: Partial<HandlerMeta>): HandlerMeta {
  const actor: Actor = overrides?.actor ?? {
    id: 'user-1',
    kind: 'user',
    tenantId: 'tenant-1',
    sessionId: null,
    roles: null,
    claims: {},
  };
  return {
    requestId: 'req-1',
    actor,
    requestTenantId: actor.tenantId,
    correlationId: 'corr-1',
    ip: null,
    bearerAuthenticated: false,
    ...overrides,
  };
}

describe('invokeWithRecordIdempotency', () => {
  test('replays cached undefined results through the serialized response envelope', async () => {
    const ctx = createContext();
    const meta = createMeta({ idempotencyKey: 'idem-1' });

    const first = await invokeWithRecordIdempotency(
      ctx,
      'processOrder',
      meta,
      { body: { orderId: '1' }, meta: {} },
      undefined,
      async () => undefined,
    );

    const second = await invokeWithRecordIdempotency(
      ctx,
      'processOrder',
      meta,
      { body: { orderId: '1' }, meta: {} },
      undefined,
      async () => 'should-not-run',
    );

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
  });

  test('throws on fingerprint conflicts for the same key by default', async () => {
    const ctx = createContext();
    const meta = createMeta({ idempotencyKey: 'idem-2' });

    await invokeWithRecordIdempotency(
      ctx,
      'processOrder',
      meta,
      { body: { orderId: '1' }, meta: {} },
      undefined,
      async () => ({ ok: true }),
    );

    await expect(
      invokeWithRecordIdempotency(
        ctx,
        'processOrder',
        meta,
        { body: { orderId: '2' }, meta: {} },
        undefined,
        async () => ({ ok: false }),
      ),
    ).rejects.toThrow('Idempotency key conflict');
  });

  test('allows cache replay across body changes when fingerprinting is disabled', async () => {
    const ctx = createContext();
    const meta = createMeta({ idempotencyKey: 'idem-3' });

    await invokeWithRecordIdempotency(
      ctx,
      'processOrder',
      meta,
      { body: { orderId: '1' }, meta: {} },
      { fingerprint: false },
      async () => ({ ok: true }),
    );

    const replayed = await invokeWithRecordIdempotency(
      ctx,
      'processOrder',
      meta,
      { body: { orderId: '2' }, meta: {} },
      { fingerprint: false },
      async () => ({ ok: false }),
    );

    expect(replayed).toEqual({ ok: true });
  });

  test('requires an authenticated subject for user-scoped keys', async () => {
    const ctx = createContext();
    const meta = createMeta({
      actor: { ...ANONYMOUS_ACTOR },
      idempotencyKey: 'idem-4',
    });

    await expect(
      invokeWithRecordIdempotency(
        ctx,
        'processOrder',
        meta,
        { body: { orderId: '1' }, meta: {} },
        { scope: 'user' },
        async () => ({ ok: true }),
      ),
    ).rejects.toThrow("Idempotency scope 'user' requires an authenticated subject");
  });
});
