import { describe, expect, it, mock } from 'bun:test';
import { createInboundRouter } from '../../src/routes/inbound';
import { WebhookInboundConfigError } from '../../src/errors/webhookErrors';
import type { InboundProvider } from '../../src/types/inbound';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockBus(): SlingshotEventBus {
  return {
    emit: mock(() => {}),
    on: mock(() => {}),
    off: mock(() => {}),
    drain: mock(async () => {}),
    onEnvelope: mock(() => {}),
  } as unknown as SlingshotEventBus;
}

function makeProvider(name: string, overrides?: Partial<InboundProvider>): InboundProvider {
  return {
    name,
    async verify() {
      return { verified: true, payload: { received: true } };
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createInboundRouter', () => {
  describe('construction', () => {
    it('throws WebhookInboundConfigError on duplicate provider names', () => {
      const p = makeProvider('stripe');
      expect(() => createInboundRouter([p, p], mockBus())).toThrow(WebhookInboundConfigError);
    });

    it('accepts an empty provider list without error', () => {
      expect(() => createInboundRouter([], mockBus())).not.toThrow();
    });
  });

  describe('provider dispatch', () => {
    it('returns 200 with { received: true } when verification passes', async () => {
      const router = createInboundRouter([makeProvider('stripe')], mockBus());
      const res = await router.request('/stripe', { method: 'POST', body: '{"ok":true}' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
    });

    it('returns 404 for an unknown provider name', async () => {
      const router = createInboundRouter([makeProvider('stripe')], mockBus());
      const res = await router.request('/ghost', { method: 'POST', body: '{}' });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/unknown provider/i);
    });

    it('returns 400 when provider.verify returns { verified: false }', async () => {
      const failing: InboundProvider = {
        name: 'failing',
        async verify() {
          return { verified: false, reason: 'bad signature' };
        },
      };
      const router = createInboundRouter([failing], mockBus());
      const res = await router.request('/failing', { method: 'POST', body: '{"x":1}' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/bad signature/i);
    });

    it('returns 400 when provider.verify throws', async () => {
      const throwing: InboundProvider = {
        name: 'broken',
        async verify() {
          throw new Error('unexpected');
        },
      };
      const router = createInboundRouter([throwing], mockBus());
      const res = await router.request('/broken', { method: 'POST', body: '{}' });
      expect(res.status).toBe(400);
    });

    it('emits webhook:inbound.<name> on success with provider and rawBody', async () => {
      const bus = mockBus();
      const router = createInboundRouter([makeProvider('stripe')], bus);
      await router.request('/stripe', { method: 'POST', body: '{"event":"charge"}' });
      expect(bus.emit).toHaveBeenCalledTimes(1);
      const [event, payload] = (bus.emit as ReturnType<typeof mock>).mock.calls[0] as [
        string,
        unknown,
      ];
      expect(event).toBe('webhook:inbound.stripe');
      expect(payload).toMatchObject({
        provider: 'stripe',
        payload: { received: true },
        rawBody: '{"event":"charge"}',
      });
    });
  });

  describe('body size limits', () => {
    it('returns 413 when Content-Length exceeds maxBodyBytes', async () => {
      const router = createInboundRouter([makeProvider('stripe')], mockBus(), {
        maxBodyBytes: 10,
      });
      const res = await router.request('/stripe', {
        method: 'POST',
        headers: { 'content-length': '100' },
        body: '{"too":"big"}',
      });
      expect(res.status).toBe(413);
    });

    it('returns 413 when streamed body exceeds maxBodyBytes', async () => {
      const router = createInboundRouter([makeProvider('stripe')], mockBus(), {
        maxBodyBytes: 5,
      });
      const res = await router.request('/stripe', {
        method: 'POST',
        body: '{"big":true}',
      });
      expect(res.status).toBe(413);
    });

    it('allows a body that fits within the limit', async () => {
      const router = createInboundRouter([makeProvider('stripe')], mockBus(), {
        maxBodyBytes: 1_000_000,
      });
      const res = await router.request('/stripe', { method: 'POST', body: '{"a":1}' });
      expect(res.status).toBe(200);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 with Retry-After and X-RateLimit headers when rate limited', async () => {
      const router = createInboundRouter([makeProvider('stripe')], mockBus(), {
        rateLimiter: { maxRequests: 1, windowMs: 60_000 },
      });
      const r1 = await router.request('/stripe', { method: 'POST', body: '{}' });
      expect(r1.status).toBe(200);

      const r2 = await router.request('/stripe', { method: 'POST', body: '{}' });
      expect(r2.status).toBe(429);
      expect(r2.headers.get('retry-after')).toBeTruthy();
      expect(r2.headers.get('x-ratelimit-remaining')).toBe('0');
      expect(r2.headers.get('x-ratelimit-limit')).toBeTruthy();
    });

    it('does not rate limit when no rateLimiter option is set', async () => {
      const router = createInboundRouter([makeProvider('stripe')], mockBus());
      for (let i = 0; i < 10; i++) {
        const res = await router.request('/stripe', { method: 'POST', body: '{}' });
        expect(res.status).toBe(200);
      }
    });

    it('accepts a custom RateLimiter instance', async () => {
      const customLimiter = {
        check() {
          return { allowed: false, remaining: 0, resetMs: 5_000 };
        },
      };
      const router = createInboundRouter([makeProvider('stripe')], mockBus(), {
        rateLimiter: customLimiter,
      });
      const res = await router.request('/stripe', { method: 'POST', body: '{}' });
      expect(res.status).toBe(429);
    });
  });
});
