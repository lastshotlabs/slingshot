import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createInboundRouter } from '../../../src/routes/inbound';
import type { InboundProvider } from '../../../src/types/inbound';

describe('inbound routes', () => {
  it('throws when provider names are duplicated', () => {
    const bus = createInProcessAdapter();
    const provider: InboundProvider = {
      name: 'stripe',
      verify: async () => ({ verified: true, payload: {} }),
    };
    expect(() => createInboundRouter([provider, provider], bus)).toThrow(
      /Duplicate inbound provider names/i,
    );
  });

  it('returns 404 for unknown provider', async () => {
    const bus = createInProcessAdapter();
    const app = new Hono();
    app.route('/webhooks/inbound', createInboundRouter([], bus));
    const res = await app.request('/webhooks/inbound/unknown', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when verification fails', async () => {
    const bus = createInProcessAdapter();
    const provider: InboundProvider = {
      name: 'stripe',
      verify: async () => ({ verified: false, reason: 'bad signature' }),
    };
    const app = new Hono();
    app.route('/webhooks/inbound', createInboundRouter([provider], bus));
    const res = await app.request('/webhooks/inbound/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type":"charge.succeeded"}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad signature');
  });

  it('returns 400 instead of 500 when provider verification throws', async () => {
    const bus = createInProcessAdapter();
    const emitMock = mock(bus.emit.bind(bus)) as typeof bus.emit;
    bus.emit = emitMock;

    const provider: InboundProvider = {
      name: 'stripe',
      verify: async () => {
        throw new Error('unexpected verifier failure');
      },
    };
    const app = new Hono();
    app.route('/webhooks/inbound', createInboundRouter([provider], bus));
    const res = await app.request('/webhooks/inbound/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type":"charge.succeeded"}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Verification failed');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('emits bus event and returns {received: true} on success', async () => {
    const bus = createInProcessAdapter();
    const emitMock = mock(bus.emit.bind(bus)) as typeof bus.emit;
    bus.emit = emitMock;

    const payload = { type: 'charge.succeeded', id: 'ch_123' };
    const provider: InboundProvider = {
      name: 'stripe',
      verify: async () => ({ verified: true, payload }),
    };
    const app = new Hono();
    app.route('/webhooks/inbound', createInboundRouter([provider], bus));
    const bodyStr = JSON.stringify(payload);
    const res = await app.request('/webhooks/inbound/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);
    expect(emitMock).toHaveBeenCalledWith('webhook:inbound.stripe', {
      provider: 'stripe',
      payload,
      rawBody: bodyStr,
    });
  });
});
