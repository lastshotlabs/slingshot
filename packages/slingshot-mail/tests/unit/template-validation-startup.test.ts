import { describe, expect, it, mock } from 'bun:test';
import type { MailRenderer } from '@lastshotlabs/slingshot-core';
import {
  MailTemplateNotFoundError,
  validateSubscriptionTemplates,
} from '../../src/lib/subscriptionWiring.js';
import type { MailPluginConfig } from '../../src/types/config.js';
import type { MailProvider, SendResult } from '../../src/types/provider.js';

function makeProvider(): MailProvider {
  return {
    name: 'mock',
    send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
  };
}

function makeRenderer(templateNames: string[]): MailRenderer {
  return {
    name: 'mock-renderer',
    render: mock(async () => ({ html: '<p>x</p>' })),
    listTemplates: mock(async () => templateNames),
  };
}

function makeConfig(overrides: Partial<MailPluginConfig> = {}): MailPluginConfig {
  return {
    provider: makeProvider(),
    renderer: makeRenderer(['welcome', 'reset']),
    from: 'noreply@example.com',
    ...overrides,
  };
}

describe('validateSubscriptionTemplates (startup)', () => {
  it('subscription with unknown templateKey throws MailTemplateNotFoundError at startup', async () => {
    const config = makeConfig({
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'does-not-exist' }],
    });

    const err = await validateSubscriptionTemplates(config).catch(e => e);

    expect(err).toBeInstanceOf(MailTemplateNotFoundError);
    expect((err as MailTemplateNotFoundError).templateName).toBe('does-not-exist');
    expect((err as MailTemplateNotFoundError).event).toBe('auth:delivery.password_reset');
    expect((err as Error).message).toContain('does-not-exist');
    expect((err as Error).message).toContain('auth:delivery.password_reset');
  });

  it('all known templates → resolves without throwing', async () => {
    const config = makeConfig({
      subscriptions: [
        { event: 'auth:delivery.password_reset', template: 'reset' },
        { event: 'auth:delivery.email_verification', template: 'welcome' },
      ],
    });

    await expect(validateSubscriptionTemplates(config)).resolves.toBeUndefined();
  });

  it('throws on the first missing template (fail-fast, does not aggregate)', async () => {
    const config = makeConfig({
      subscriptions: [
        { event: 'auth:delivery.password_reset', template: 'first-missing' },
        { event: 'auth:delivery.email_verification', template: 'second-missing' },
      ],
    });

    const err = await validateSubscriptionTemplates(config).catch(e => e);
    expect(err).toBeInstanceOf(MailTemplateNotFoundError);
    expect((err as MailTemplateNotFoundError).templateName).toBe('first-missing');
  });

  it('renderer without listTemplates() → cannot validate, does not throw', async () => {
    const renderer: MailRenderer = {
      name: 'no-list-renderer',
      render: mock(async () => ({ html: '<p>hi</p>' })),
      // listTemplates intentionally omitted
    };
    const config = makeConfig({
      renderer,
      subscriptions: [{ event: 'auth:delivery.password_reset', template: 'whatever' }],
    });

    await expect(validateSubscriptionTemplates(config)).resolves.toBeUndefined();
  });

  it('no subscriptions configured → no-op', async () => {
    const config = makeConfig({ subscriptions: [] });
    await expect(validateSubscriptionTemplates(config)).resolves.toBeUndefined();
  });
});
