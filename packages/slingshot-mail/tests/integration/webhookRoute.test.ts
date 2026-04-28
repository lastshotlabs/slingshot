import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type {
  SlingshotEventBus,
  SlingshotFrameworkConfig,
} from '@lastshotlabs/slingshot-core';
import { createMailPlugin } from '../../src/plugin.js';
import { createMemoryQueue } from '../../src/queues/memory.js';
import { createRawHtmlRenderer } from '../../src/renderers/rawHtml.js';
import type { MailProvider, SendResult } from '../../src/types/provider.js';

const MOCK_CFG = {} as unknown as SlingshotFrameworkConfig;

function makeProvider(): MailProvider {
  return {
    name: 'mock',
    send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
    healthCheck: mock(async () => {}),
  };
}

let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

/**
 * P-MAIL-10: provider webhooks land at `/mail/webhook/:provider`,
 * normalize bounce/complaint records, emit on the bus, and call the
 * configured `markEmailUnsubscribed` adapter.
 */
describe('mail webhook route (P-MAIL-10)', () => {
  it('Resend bounce → emits mail:bounce and invokes markEmailUnsubscribed', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({ templates: {} });
    const queue = createMemoryQueue();
    warnSpy.mockClear();
    const provider = makeProvider();
    const markEmailUnsubscribed = mock(async () => {});
    const events: unknown[] = [];
    bus.on('mail:bounce' as never, (payload: unknown) => {
      events.push(payload);
    });

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      markEmailUnsubscribed,
    });

    const app = new Hono();
    plugin.setupRoutes!({
      app: app as never,
      config: MOCK_CFG,
      bus,
      events: bus as never,
    });
    await plugin.setupPost!({
      app: app as never,
      config: MOCK_CFG,
      bus,
      events: bus as never,
    });

    const res = await app.request('/mail/webhook/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'email.bounced',
        data: { email: 'b@example.com', bounce: { type: 'permanent' } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; processed: number };
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(1);
    expect(markEmailUnsubscribed.mock.calls).toHaveLength(1);
    expect(events).toHaveLength(1);

    await plugin.teardown!();
    await bus.shutdown?.();
  });

  it('SES SubscriptionConfirmation returns confirm-required without emitting events', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({ templates: {} });
    const queue = createMemoryQueue();
    warnSpy.mockClear();
    const provider = makeProvider();
    const events: unknown[] = [];
    bus.on('mail:bounce' as never, (payload: unknown) => {
      events.push(payload);
    });

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
    });

    const app = new Hono();
    plugin.setupRoutes!({
      app: app as never,
      config: MOCK_CFG,
      bus,
      events: bus as never,
    });
    await plugin.setupPost!({
      app: app as never,
      config: MOCK_CFG,
      bus,
      events: bus as never,
    });

    const res = await app.request('/mail/webhook/ses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        Type: 'SubscriptionConfirmation',
        SubscribeURL: 'https://sns.example.com/confirm?token=x',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe('confirm-required');
    expect(events).toHaveLength(0);

    await plugin.teardown!();
    await bus.shutdown?.();
  });

  it('unsupported provider returns 400', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({ templates: {} });
    const queue = createMemoryQueue();
    warnSpy.mockClear();
    const provider = makeProvider();
    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
    });
    const app = new Hono();
    plugin.setupRoutes!({
      app: app as never,
      config: MOCK_CFG,
      bus,
      events: bus as never,
    });
    await plugin.setupPost!({
      app: app as never,
      config: MOCK_CFG,
      bus,
      events: bus as never,
    });
    const res = await app.request('/mail/webhook/sendgrid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    await plugin.teardown!();
    await bus.shutdown?.();
  });

  it('webhookRoute: "" disables the route', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({ templates: {} });
    const queue = createMemoryQueue();
    warnSpy.mockClear();
    const provider = makeProvider();
    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      webhookRoute: '',
    });
    const app = new Hono();
    plugin.setupRoutes!({
      app: app as never,
      config: MOCK_CFG,
      bus,
      events: bus as never,
    });
    await plugin.setupPost!({
      app: app as never,
      config: MOCK_CFG,
      bus,
      events: bus as never,
    });
    const res = await app.request('/mail/webhook/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    await plugin.teardown!();
    await bus.shutdown?.();
  });
});
