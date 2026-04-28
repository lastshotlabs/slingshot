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

  it('returns 413 when Content-Length exceeds the configured maxBodyBytes', async () => {
    const bus = createInProcessAdapter();
    const verifySpy = mock(async () => ({ verified: true, payload: {} }));
    const provider: InboundProvider = {
      name: 'stripe',
      verify: verifySpy as InboundProvider['verify'],
    };
    const app = new Hono();
    app.route('/webhooks/inbound', createInboundRouter([provider], bus, { maxBodyBytes: 64 }));
    // Build a body well past the cap so the declared Content-Length triggers
    // the fast-path 413 before the route ever reads the request body.
    const bigBody = 'x'.repeat(1024);
    const res = await app.request('/webhooks/inbound/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(bigBody.length) },
      body: bigBody,
    });
    expect(res.status).toBe(413);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('returns 413 when streamed body exceeds the cap without a Content-Length hint', async () => {
    const bus = createInProcessAdapter();
    const verifySpy = mock(async () => ({ verified: true, payload: {} }));
    const provider: InboundProvider = {
      name: 'stripe',
      verify: verifySpy as InboundProvider['verify'],
    };
    const app = new Hono();
    app.route('/webhooks/inbound', createInboundRouter([provider], bus, { maxBodyBytes: 64 }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Send four chunks of 32 bytes (128 bytes total) so the stream-bounded
        // reader has to detect overflow on the second chunk.
        for (let i = 0; i < 4; i++) {
          controller.enqueue(new TextEncoder().encode('y'.repeat(32)));
        }
        controller.close();
      },
    });
    const res = await app.fetch(
      new Request('http://app.local/webhooks/inbound/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        // duplex is required by undici/Bun when sending a ReadableStream body.
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(res.status).toBe(413);
    expect(verifySpy).not.toHaveBeenCalled();
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
