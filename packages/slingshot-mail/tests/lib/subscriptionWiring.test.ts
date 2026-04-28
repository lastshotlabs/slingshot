import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { SlingshotEventBus, SlingshotEventMap } from '@lastshotlabs/slingshot-core';
import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
import { wireSubscriptions } from '../../src/lib/subscriptionWiring.js';
import type { MailPluginConfig } from '../../src/types/config.js';
import type { SendResult } from '../../src/types/provider.js';
import type { MailQueue } from '../../src/types/queue.js';

type AnyPayload = SlingshotEventMap[keyof SlingshotEventMap];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBus() {
  const handlers: Map<string, Set<(...args: unknown[]) => unknown>> = new Map();
  return {
    on: mock((event: string, handler: (...args: unknown[]) => unknown) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    }),
    off: mock((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.get(event)?.delete(handler);
    }),
    emit: async (event: string, payload: unknown) => {
      const set = handlers.get(event);
      if (!set) return;
      for (const handler of set) {
        await handler(payload);
      }
    },
  } as unknown as SlingshotEventBus & { emit: (event: string, payload: unknown) => Promise<void> };
}

function makeQueue() {
  return {
    name: 'test-queue',
    enqueue: mock(async () => 'job-id'),
    start: mock(async () => {}),
    stop: mock(async () => {}),
    depth: mock(async () => 0),
  } as unknown as MailQueue;
}

function makeRenderer(
  result: { subject?: string; html: string; text?: string } = {
    html: '<p>hello</p>',
    subject: 'Renderer Subject',
  },
) {
  return {
    name: 'test-renderer',
    render: mock(async () => result),
    listTemplates: mock(async () => []),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let consoleSpy: ReturnType<typeof spyOn<any, any>>;

beforeEach(() => {
  consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wireSubscriptions', () => {
  it('fires event → recipientMapper + dataMapper called → render() called → enqueue() with correct to/subject/html', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer({
      html: '<p>reset</p>',
      subject: 'Renderer Subject',
      text: 'reset',
    });

    const dataMapper = mock((payload: Record<string, unknown>) => ({ token: payload.token }));
    const recipientMapper = mock((payload: Record<string, unknown>) => payload.email as string);

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [
        {
          event: 'auth:delivery.password_reset',
          template: 'password_reset',
          subject: 'Reset your password',
          dataMapper: dataMapper as unknown as (payload: AnyPayload) => Record<string, unknown>,
          recipientMapper: recipientMapper as unknown as (payload: AnyPayload) => string,
        },
      ],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);

    await bus.emit('auth:delivery.password_reset', { email: 'user@example.com', token: 'tok123' });

    expect(dataMapper).toHaveBeenCalledTimes(1);
    expect(recipientMapper).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledWith('password_reset', { token: 'tok123' });

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const [msg] = (queue.enqueue as ReturnType<typeof mock>).mock.calls[0] as [
      { to: string; subject: string; html: string },
    ];
    expect(msg.to).toBe('user@example.com');
    expect(msg.subject).toBe('Reset your password');
    expect(msg.html).toBe('<p>reset</p>');
  });

  it('recipientMapper absent → falls back to payload.email', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer();

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'tpl' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);
    await bus.emit('auth:delivery.password_reset', { email: 'fallback@example.com', token: 'tok' });

    const [msg] = (queue.enqueue as ReturnType<typeof mock>).mock.calls[0] as [{ to: string }];
    expect(msg.to).toBe('fallback@example.com');
  });

  it('dataMapper absent → passes payload directly to renderer', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer();

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'tpl' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);
    const payload = { email: 'u@example.com', token: 'abc' };
    await bus.emit('auth:delivery.password_reset', payload);

    expect(renderer.render).toHaveBeenCalledWith('tpl', payload);
  });

  it('subject resolution: subscription override wins over renderer subject', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer({ html: '<p>x</p>', subject: 'Renderer Subject' });

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [
        { event: 'auth:delivery.password_reset', template: 'tpl', subject: 'Override Subject' },
      ],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);
    await bus.emit('auth:delivery.password_reset', { email: 'u@example.com', token: 't' });

    const [msg] = (queue.enqueue as ReturnType<typeof mock>).mock.calls[0] as [{ subject: string }];
    expect(msg.subject).toBe('Override Subject');
  });

  it('subject resolution: renderer subject used when no subscription subject', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer({ html: '<p>x</p>', subject: 'Renderer Subject' });

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'tpl' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);
    await bus.emit('auth:delivery.password_reset', { email: 'u@example.com', token: 't' });

    const [msg] = (queue.enqueue as ReturnType<typeof mock>).mock.calls[0] as [{ subject: string }];
    expect(msg.subject).toBe('Renderer Subject');
  });

  it('subject resolution: falls back to "(no subject)" when neither provided', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer({ html: '<p>x</p>' }); // no subject

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'tpl' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);
    await bus.emit('auth:delivery.password_reset', { email: 'u@example.com', token: 't' });

    const [msg] = (queue.enqueue as ReturnType<typeof mock>).mock.calls[0] as [{ subject: string }];
    expect(msg.subject).toBe('(no subject)');
  });

  it('TemplateNotFoundError → logged, not rethrown, enqueue not called', async () => {
    const bus = makeBus();
    const queue = makeQueue();

    const renderer = {
      name: 'test',
      render: mock(async () => {
        throw new TemplateNotFoundError('missing-template');
      }),
      listTemplates: mock(async () => []),
    };

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'missing-template' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);

    // Should not throw
    await bus.emit('auth:delivery.password_reset', { email: 'u@example.com', token: 't' });

    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const errorMsg = (consoleSpy.mock.calls[0] as string[])[0];
    expect(errorMsg).toContain('Template not found');
  });

  it('other errors → logged, not rethrown, enqueue not called', async () => {
    const bus = makeBus();
    const queue = makeQueue();

    const renderer = {
      name: 'test',
      render: mock(async () => {
        throw new Error('Unexpected render error');
      }),
      listTemplates: mock(async () => []),
    };

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'tpl' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);

    await bus.emit('auth:delivery.password_reset', { email: 'u@example.com', token: 't' });

    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it('return value: each unsubscriber calls bus.off(event, handler)', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer();

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [
        { event: 'auth:delivery.password_reset', template: 'tpl1' },
        { event: 'auth:delivery.email_verification', template: 'tpl2' },
      ],
    };

    const unsubscribers = wireSubscriptions(bus as SlingshotEventBus, config, queue);
    expect(unsubscribers).toHaveLength(2);

    // Call both unsubscribers
    unsubscribers[0]();
    unsubscribers[1]();

    expect(bus.off as ReturnType<typeof mock>).toHaveBeenCalledTimes(2);
    const call0 = ((bus.off as ReturnType<typeof mock>).mock.calls[0] as [string])[0];
    const call1 = ((bus.off as ReturnType<typeof mock>).mock.calls[1] as [string])[0];
    expect(call0).toBe('auth:delivery.password_reset');
    expect(call1).toBe('auth:delivery.email_verification');
  });

  it('empty subscriptions → returns empty array', () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer();

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptions: [],
    };

    const unsubscribers = wireSubscriptions(bus as SlingshotEventBus, config, queue);
    expect(unsubscribers).toEqual([]);
  });

  it('no recipient (no recipientMapper and no payload.email) → does not enqueue', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer();
    const onSubscriptionDrop = mock(async () => {});

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      onSubscriptionDrop,
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'tpl' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);
    // payload has no email field
    await bus.emit('auth:delivery.password_reset', {
      token: 'abc',
    } as unknown as SlingshotEventMap['auth:delivery.password_reset']);

    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(onSubscriptionDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth:delivery.password_reset',
        template: 'tpl',
        reason: 'missing-recipient',
      }),
    );
  });

  it('queue enqueue rejection is reported to onSubscriptionDrop', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer();
    const failure = new Error('queue unavailable');
    const onSubscriptionDrop = mock(async () => {});
    (queue.enqueue as ReturnType<typeof mock>).mockImplementation(async () => {
      throw failure;
    });

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      onSubscriptionDrop,
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'tpl' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);
    await bus.emit('auth:delivery.password_reset', { email: 'u@example.com', token: 't' });

    expect(onSubscriptionDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth:delivery.password_reset',
        template: 'tpl',
        reason: 'enqueue-error',
        error: failure,
      }),
    );
  });

  it('slow queue enqueue is timed out and reported to onSubscriptionDrop', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer();
    const onSubscriptionDrop = mock(async () => {});
    (queue.enqueue as ReturnType<typeof mock>).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return 'late-job';
    });

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      subscriptionEnqueueTimeoutMs: 1,
      onSubscriptionDrop,
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'tpl' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);
    await bus.emit('auth:delivery.password_reset', { email: 'u@example.com', token: 't' });

    expect(onSubscriptionDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth:delivery.password_reset',
        template: 'tpl',
        reason: 'enqueue-timeout',
      }),
    );
  });

  it('durableSubscriptions: true → bus.on called with durable opts and valid name', async () => {
    const bus = makeBus();
    const queue = makeQueue();
    const renderer = makeRenderer();

    const config: MailPluginConfig = {
      provider: {
        name: 'test',
        send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
      },
      renderer,
      from: 'no-reply@example.com',
      durableSubscriptions: true,
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'password_reset' }],
    };

    wireSubscriptions(bus as SlingshotEventBus, config, queue);

    expect(bus.on as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
    const call = (bus.on as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      (...args: unknown[]) => unknown,
      { durable: boolean; name: string },
    ];
    const opts = call[2];
    expect(opts).toBeDefined();
    expect(opts.durable).toBe(true);
    expect(opts.name).toBe('slingshot-mail:auth:delivery.password_reset:password_reset');
  });
});
