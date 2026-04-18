import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { SlingshotEventBus, SlingshotFrameworkConfig } from '@lastshotlabs/slingshot-core';
import { createMailPlugin } from '../../src/plugin.js';
import { createMemoryQueue } from '../../src/queues/memory.js';
import { createRawHtmlRenderer } from '../../src/renderers/rawHtml.js';
import type { MailMessage, MailProvider, SendResult } from '../../src/types/provider.js';

const MOCK_CFG = {} as unknown as SlingshotFrameworkConfig;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Yields to the microtask queue long enough for an async event handler chain
 * (emit → handler → render → enqueue → processJob) to fully settle before
 * calling drain(). setImmediate runs after all currently-queued microtasks.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function makeMockProvider(): MailProvider & { calls: MailMessage[] } {
  const calls: MailMessage[] = [];
  return {
    name: 'mock',
    calls,
    send: mock(async (message: MailMessage): Promise<SendResult> => {
      calls.push(message);
      return { status: 'sent' };
    }),
  };
}

// Suppress memory queue "not durable" warnings throughout this file.
const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

describe('createMailPlugin integration', () => {
  let bus: SlingshotEventBus;

  beforeEach(() => {
    bus = createInProcessAdapter();
    warnSpy.mockClear();
  });

  afterEach(async () => {
    await bus.shutdown?.();
  });

  it('wires subscription and calls provider.send when event is emitted', async () => {
    const provider = makeMockProvider();
    const renderer = createRawHtmlRenderer({
      templates: {
        password_reset: {
          subject: 'Reset your password',
          html: '<p>Reset link: {{resetLink}}</p>',
          text: 'Reset link: {{resetLink}}',
        },
      },
    });
    const queue = createMemoryQueue();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      subscriptions: [
        {
          event: 'auth:delivery.password_reset',
          template: 'password_reset',
          dataMapper: (payload: any) => ({
            resetLink: `https://app.example.com/reset?token=${payload.token}`,
          }),
          recipientMapper: (payload: any) => payload.email,
        },
      ],
    });

    await plugin.setupPost!({ app: {} as never, config: MOCK_CFG, bus });

    bus.emit('auth:delivery.password_reset', {
      email: 'user@example.com',
      token: 'abc123',
    });

    await flushMicrotasks();
    await queue.drain!();

    expect(provider.calls).toHaveLength(1);
    const sent = provider.calls[0];
    expect(sent.to).toBe('user@example.com');
    expect(sent.from).toBe('noreply@example.com');
    expect(sent.subject).toBe('Reset your password');
    expect(sent.html).toContain('abc123');

    await plugin.teardown!();
  });

  it('uses setupPost for framework integration', async () => {
    const provider = makeMockProvider();
    const renderer = createRawHtmlRenderer({
      templates: {
        welcome: {
          subject: 'Welcome to {{appName}}',
          html: '<p>Welcome!</p>',
        },
      },
    });
    const queue = createMemoryQueue();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      subscriptions: [
        {
          event: 'auth:delivery.welcome',
          template: 'welcome',
          dataMapper: (payload: any) => ({ appName: 'TestApp', identifier: payload.identifier }),
          recipientMapper: (payload: any) => payload.email,
        },
      ],
    });

    await plugin.setupPost!({ app: {} as never, config: MOCK_CFG, bus });

    bus.emit('auth:delivery.welcome', {
      email: 'new@example.com',
      identifier: 'new@example.com',
    });

    await flushMicrotasks();
    await queue.drain!();

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].to).toBe('new@example.com');
    expect(provider.calls[0].subject).toBe('Welcome to TestApp');

    await plugin.teardown!();
  });

  it('unwires subscriptions on teardown', async () => {
    const provider = makeMockProvider();
    const renderer = createRawHtmlRenderer({
      templates: {
        password_reset: { subject: 'Reset', html: '<p>Reset</p>' },
      },
    });
    const queue = createMemoryQueue();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      subscriptions: [
        {
          event: 'auth:delivery.password_reset',
          template: 'password_reset',
          recipientMapper: (payload: any) => payload.email,
        },
      ],
    });

    await plugin.setupPost!({ app: {} as never, config: MOCK_CFG, bus });

    // Teardown before emitting
    await plugin.teardown!();

    bus.emit('auth:delivery.password_reset', { email: 'user@example.com', token: 'tok' });
    await flushMicrotasks();
    await queue.drain!();

    // No sends after teardown
    expect(provider.calls).toHaveLength(0);
  });

  it('uses subscription-level subject override over renderer subject', async () => {
    const provider = makeMockProvider();
    const renderer = createRawHtmlRenderer({
      templates: {
        otp: {
          subject: 'Renderer subject',
          html: '<p>Code: {{code}}</p>',
        },
      },
    });
    const queue = createMemoryQueue();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      subscriptions: [
        {
          event: 'auth:delivery.email_otp',
          template: 'otp',
          subject: 'Your OTP code',
          dataMapper: (payload: any) => ({ code: payload.code }),
          recipientMapper: (payload: any) => payload.email,
        },
      ],
    });

    await plugin.setupPost!({ app: {} as never, config: MOCK_CFG, bus });

    bus.emit('auth:delivery.email_otp', { email: 'user@example.com', code: '123456' });
    await flushMicrotasks();
    await queue.drain!();

    expect(provider.calls[0].subject).toBe('Your OTP code');

    await plugin.teardown!();
  });

  it('handles missing recipient gracefully (no crash)', async () => {
    const provider = makeMockProvider();
    const renderer = createRawHtmlRenderer({
      templates: {
        noRecip: { subject: 'X', html: '<p>X</p>' },
      },
    });
    const queue = createMemoryQueue();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      subscriptions: [
        {
          event: 'security.auth.login.success',
          template: 'noRecip',
          // No recipientMapper, event payload has no 'email' field
        },
      ],
    });

    await plugin.setupPost!({ app: {} as never, config: MOCK_CFG, bus });

    // Should not throw
    bus.emit('security.auth.login.success', { userId: 'u1', ip: '127.0.0.1' });
    await flushMicrotasks();
    await queue.drain!();

    // No sends because no recipient
    expect(provider.calls).toHaveLength(0);

    await plugin.teardown!();
  });

  it('throws if setupPost() is called twice', async () => {
    const provider = makeMockProvider();
    const renderer = createRawHtmlRenderer({ templates: {} });
    const queue = createMemoryQueue();

    const plugin = createMailPlugin({ provider, renderer, from: 'noreply@example.com', queue });

    await plugin.setupPost!({ app: {} as never, config: MOCK_CFG, bus });

    await expect(plugin.setupPost!({ app: {} as never, config: MOCK_CFG, bus })).rejects.toThrow(
      'already activated',
    );

    await plugin.teardown!();
  });
});
