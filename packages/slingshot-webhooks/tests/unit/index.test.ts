import { describe, expect, test } from 'bun:test';
import * as webhooks from '../../src/index';

describe('slingshot-webhooks public entrypoint', () => {
  test('exports the runtime factories and constants expected by consumers', () => {
    expect(webhooks.createWebhookPlugin).toBeFunction();
    expect(webhooks.WEBHOOK_ROUTES).toBeDefined();
    expect(webhooks.WEBHOOKS_PLUGIN_STATE_KEY).toBe('slingshot-webhooks');
    expect(webhooks.webhookPluginConfigSchema.safeParse({}).success).toBe(true);
    expect(webhooks.createMemoryWebhookAdapter).toBeFunction();
    expect(webhooks.createWebhookMemoryQueue).toBeFunction();
    expect(webhooks.safeParseInboundBody).toBeFunction();
    expect(webhooks.signPayload).toBeFunction();
    expect(webhooks.verifySignature).toBeFunction();
    expect(webhooks.createSecretCipher).toBeFunction();
    expect(webhooks.createSlidingWindowRateLimiter).toBeFunction();
    expect(webhooks.WebhookDeliveryError).toBeFunction();
    expect(webhooks.WebhookSecretDecryptError).toBeFunction();
  });
});
