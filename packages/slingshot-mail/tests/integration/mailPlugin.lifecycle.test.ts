import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type {
  MailRenderer,
  SlingshotEventBus,
  SlingshotFrameworkConfig,
} from '@lastshotlabs/slingshot-core';
import { createMailPlugin } from '../../src/plugin.js';
import { createMemoryQueue } from '../../src/queues/memory.js';
import { createRawHtmlRenderer } from '../../src/renderers/rawHtml.js';
import type { MailProvider, SendResult } from '../../src/types/provider.js';

const MOCK_CFG = {} as unknown as SlingshotFrameworkConfig;
const MOCK_APP_RAW = {};
const MOCK_APP = MOCK_APP_RAW as never;

function makeMockProvider(opts?: { healthCheckFails?: boolean }): MailProvider {
  const provider: MailProvider = {
    name: 'mock',
    send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
  };
  if (opts?.healthCheckFails) {
    provider.healthCheck = mock(async () => {
      throw new Error('provider unreachable');
    });
  } else {
    provider.healthCheck = mock(async () => {});
  }
  return provider;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let warnSpy: ReturnType<typeof spyOn<any, any>>;

beforeEach(() => {
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** Create a memory queue and reset the spy so the queue's own warning is not counted. */
function freshQueue() {
  const queue = createMemoryQueue();
  warnSpy.mockClear();
  return queue;
}

describe('createMailPlugin lifecycle', () => {
  it('validateTemplatesOnStartup: true + renderer has listTemplates() + missing template → console.warn called', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({
      templates: {
        welcome: { subject: 'Welcome', html: '<p>Welcome</p>' },
      },
    });
    const queue = freshQueue();
    const provider = makeMockProvider();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      validateTemplatesOnStartup: true,
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'missing_template' }],
    });

    await plugin.setupPost!({ app: MOCK_APP, config: MOCK_CFG, bus });

    const warnMsgs = warnSpy.mock.calls.map(call => (call as string[])[0]);
    const templateWarnMsg = warnMsgs.find(m => m.includes('missing_template'));
    expect(templateWarnMsg).toBeDefined();

    await plugin.teardown!();
    await bus.shutdown?.();
  });

  it('validateTemplatesOnStartup: false → warn NOT called even if template missing', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({
      templates: {
        welcome: { subject: 'Welcome', html: '<p>Welcome</p>' },
      },
    });
    const queue = freshQueue();
    const provider = makeMockProvider();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      validateTemplatesOnStartup: false,
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'missing_template' }],
    });

    await plugin.setupPost!({ app: MOCK_APP, config: MOCK_CFG, bus });

    expect(warnSpy).not.toHaveBeenCalled();

    await plugin.teardown!();
    await bus.shutdown?.();
  });

  it('validateTemplatesOnStartup: true + renderer has no listTemplates() → no crash, warn NOT called', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer: MailRenderer = {
      name: 'no-list-renderer',
      render: mock(async () => ({ html: '<p>hi</p>' })),
      // listTemplates intentionally absent
    };
    const queue = freshQueue();
    const provider = makeMockProvider();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      validateTemplatesOnStartup: true,
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'whatever' }],
    });

    // Should not throw
    await plugin.setupPost!({ app: MOCK_APP, config: MOCK_CFG, bus });

    expect(warnSpy).not.toHaveBeenCalled();

    await plugin.teardown!();
    await bus.shutdown?.();
  });

  it('provider healthCheck() failing → console.warn logged, plugin still activates', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({ templates: {} });
    const queue = freshQueue();
    const provider = makeMockProvider({ healthCheckFails: true });

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
    });

    // Should not throw
    await plugin.setupPost!({ app: MOCK_APP, config: MOCK_CFG, bus });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = (warnSpy.mock.calls[0] as string[])[0];
    expect(warnMsg).toContain('health check failed');
    expect(warnMsg).toContain('provider unreachable');

    await plugin.teardown!();
    await bus.shutdown?.();
  });

  it('provider healthCheck() succeeding → no warning', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({ templates: {} });
    const queue = freshQueue();
    const provider = makeMockProvider();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
    });

    await plugin.setupPost!({ app: MOCK_APP, config: MOCK_CFG, bus });

    expect(warnSpy).not.toHaveBeenCalled();

    await plugin.teardown!();
    await bus.shutdown?.();
  });

  it('queue startup failure tears down cleanly and allows retry', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({ templates: {} });
    const start = mock(async () => {
      if (start.mock.calls.length === 1) {
        throw new Error('queue offline');
      }
    });
    const stop = mock(async () => {});
    const queue = {
      name: 'test-queue',
      enqueue: mock(async () => 'job-1'),
      start,
      stop,
      depth: mock(async () => 0),
      drain: mock(async () => {}),
    };
    const provider = makeMockProvider();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      subscriptions: [],
    });

    await expect(plugin.setupPost!({ app: MOCK_APP, config: MOCK_CFG, bus })).rejects.toThrow(
      'queue offline',
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);

    await expect(
      plugin.setupPost!({ app: MOCK_APP, config: MOCK_CFG, bus }),
    ).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);

    await plugin.teardown!();
    await bus.shutdown?.();
  });

  it('teardown() called before setup() → no crash (queue is undefined)', async () => {
    const renderer = createRawHtmlRenderer({ templates: {} });
    const provider = makeMockProvider();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
    });

    // Should not throw — queue is undefined
    await expect(plugin.teardown!()).resolves.toBeUndefined();
  });

  it('template validation warns for each missing template individually (2 missing → 2 warns)', async () => {
    const bus: SlingshotEventBus = createInProcessAdapter();
    const renderer = createRawHtmlRenderer({
      templates: {
        existing: { subject: 'Exists', html: '<p>exists</p>' },
      },
    });
    const queue = freshQueue();
    const provider = makeMockProvider();

    const plugin = createMailPlugin({
      provider,
      renderer,
      from: 'noreply@example.com',
      queue,
      validateTemplatesOnStartup: true,
      subscriptions: [
        { event: 'auth:delivery.password_reset', template: 'missing_one' },
        { event: 'auth:delivery.email_verification', template: 'missing_two' },
      ],
    });

    await plugin.setupPost!({ app: MOCK_APP, config: MOCK_CFG, bus });

    expect(warnSpy).toHaveBeenCalledTimes(2);
    const warnMsgs = warnSpy.mock.calls.map(call => (call as string[])[0]);
    expect(warnMsgs.some(m => m.includes('missing_one'))).toBe(true);
    expect(warnMsgs.some(m => m.includes('missing_two'))).toBe(true);

    await plugin.teardown!();
    await bus.shutdown?.();
  });
});
