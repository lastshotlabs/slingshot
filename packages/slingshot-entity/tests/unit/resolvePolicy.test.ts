import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type {
  EntityRoutePolicyConfig,
  PolicyDecision,
  PolicyResolver,
} from '@lastshotlabs/slingshot-core';
import {
  buildPolicyAction,
  policyAppliesToOp,
  resolvePolicy,
} from '../../src/policy/resolvePolicy';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<EntityRoutePolicyConfig>): EntityRoutePolicyConfig {
  return { resolver: 'test:policy', ...overrides };
}

function makeBus(): { emit: ReturnType<typeof import('bun:test').mock>; emitted: unknown[] } {
  const emitted: unknown[] = [];
  return {
    emit: ((...args: unknown[]) => {
      emitted.push(args);
    }) as never,
    emitted,
  };
}

async function runPolicy(
  resolver: PolicyResolver,
  config?: Partial<EntityRoutePolicyConfig>,
  opts?: { userId?: string; record?: unknown; input?: unknown; bus?: unknown },
) {
  const app = new Hono();
  app.post('/test', async c => {
    c.set(
      'actor' as never,
      Object.freeze({
        id: opts?.userId ?? 'user-1',
        kind: 'user' as const,
        tenantId: 'tenant-1',
        sessionId: null,
        roles: null,
        claims: {},
      }) as never,
    );
    await resolvePolicy({
      c,
      config: makeConfig(config),
      resolver,
      action: { kind: 'get' },
      record: opts?.record ?? null,
      input: opts?.input ?? null,
      bus: opts?.bus as never,
    });
    return c.json({ ok: true });
  });
  return app.request('/test', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// resolvePolicy
// ---------------------------------------------------------------------------

describe('resolvePolicy', () => {
  test('resolver returning true → request passes', async () => {
    const res = await runPolicy(() => Promise.resolve(true));
    expect(res.status).toBe(200);
  });

  test('resolver returning false → 403', async () => {
    const res = await runPolicy(() => Promise.resolve(false));
    expect(res.status).toBe(403);
  });

  test('resolver returning { allow: false } → 403', async () => {
    const res = await runPolicy(() => Promise.resolve({ allow: false }));
    expect(res.status).toBe(403);
  });

  test('resolver returning { allow: false, status: 404 } → 404', async () => {
    const res = await runPolicy(() =>
      Promise.resolve({ allow: false, status: 404 } as unknown as PolicyDecision),
    );
    expect(res.status).toBe(404);
  });

  test('leakSafe config → 404 even without explicit status', async () => {
    const res = await runPolicy(() => Promise.resolve(false), { leakSafe: true });
    expect(res.status).toBe(404);
  });

  test('resolver returning { allow: true } → passes', async () => {
    const res = await runPolicy(() => Promise.resolve({ allow: true }));
    expect(res.status).toBe(200);
  });

  test('missing userId → 500', async () => {
    const app = new Hono();
    app.post('/test', async c => {
      // deliberately do NOT set actor
      await resolvePolicy({
        c,
        config: makeConfig(),
        resolver: () => Promise.resolve(true),
        action: { kind: 'get' },
        record: null,
        input: null,
      });
      return c.json({ ok: true });
    });
    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  test('resolver throwing → 500', async () => {
    const res = await runPolicy(() => Promise.reject(new Error('boom')));
    expect(res.status).toBe(500);
  });

  test('deny emits entity:policy.denied on bus', async () => {
    const bus = makeBus();
    await runPolicy(() => Promise.resolve(false), undefined, { bus });
    expect(bus.emitted.length).toBe(1);
    const [key, payload] = bus.emitted[0] as [string, Record<string, unknown>];
    expect(key).toBe('entity:policy.denied');
    expect(payload.userId).toBe('user-1');
    expect(payload.resolverKey).toBe('test:policy');
  });

  test('allow does NOT emit on bus', async () => {
    const bus = makeBus();
    await runPolicy(() => Promise.resolve(true), undefined, { bus });
    expect(bus.emitted.length).toBe(0);
  });

  test('record is passed to resolver', async () => {
    let receivedRecord: unknown;
    const resolver: PolicyResolver = input => {
      receivedRecord = input.record;
      return Promise.resolve(true);
    };
    await runPolicy(resolver, undefined, { record: { id: 'rec-1' } });
    expect(receivedRecord).toEqual({ id: 'rec-1' });
  });
});

// ---------------------------------------------------------------------------
// policyAppliesToOp
// ---------------------------------------------------------------------------

describe('policyAppliesToOp', () => {
  test('no applyTo → applies to all', () => {
    expect(policyAppliesToOp(makeConfig(), 'create')).toBe(true);
    expect(policyAppliesToOp(makeConfig(), 'get')).toBe(true);
    expect(policyAppliesToOp(makeConfig(), 'customOp')).toBe(true);
  });

  test('applyTo with CRUD ops', () => {
    const config = makeConfig({ applyTo: ['create', 'update'] });
    expect(policyAppliesToOp(config, 'create')).toBe(true);
    expect(policyAppliesToOp(config, 'update')).toBe(true);
    expect(policyAppliesToOp(config, 'get')).toBe(false);
    expect(policyAppliesToOp(config, 'delete')).toBe(false);
  });

  test('applyTo with named operation', () => {
    const config = makeConfig({ applyTo: ['operation:closePoll'] });
    expect(policyAppliesToOp(config, 'closePoll')).toBe(true);
    expect(policyAppliesToOp(config, 'create')).toBe(false);
  });

  test('applyTo with mixed CRUD and named', () => {
    const config = makeConfig({ applyTo: ['get', 'operation:publish'] });
    expect(policyAppliesToOp(config, 'get')).toBe(true);
    expect(policyAppliesToOp(config, 'publish')).toBe(true);
    expect(policyAppliesToOp(config, 'create')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPolicyAction
// ---------------------------------------------------------------------------

describe('buildPolicyAction', () => {
  test('CRUD ops return kind-only', () => {
    expect(buildPolicyAction('create')).toEqual({ kind: 'create' });
    expect(buildPolicyAction('get')).toEqual({ kind: 'get' });
    expect(buildPolicyAction('list')).toEqual({ kind: 'list' });
    expect(buildPolicyAction('update')).toEqual({ kind: 'update' });
    expect(buildPolicyAction('delete')).toEqual({ kind: 'delete' });
  });

  test('named op returns kind: operation with name', () => {
    expect(buildPolicyAction('closePoll')).toEqual({ kind: 'operation', name: 'closePoll' });
  });
});
