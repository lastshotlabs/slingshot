import { describe, expect, mock, spyOn, test } from 'bun:test';
import { deliverWebhook } from '../../src/lib/dispatcher.js';

/**
 * P-WEBHOOKS-5: SSRF protection cannot be disabled by default. The only
 * way to deliver to a private/loopback IP is the per-call
 * `allowPrivateIps: true` opt-in, which logs a loud warning every time.
 */
describe('webhook SSRF allowPrivateIps gate (P-WEBHOOKS-5)', () => {
  test('default delivery to loopback is blocked', async () => {
    const job = {
      id: 'job-1',
      deliveryId: 'd1',
      endpointId: 'ep1',
      url: 'http://127.0.0.1/hook',
      secret: 'x',
      event: 'evt' as never,
      eventId: 'e1',
      occurredAt: new Date().toISOString(),
      subscriber: { ownerType: 'tenant' as const, ownerId: 't', tenantId: 't' },
      payload: '{}',
      attempts: 0,
      createdAt: new Date(),
    };
    // validateWebhookUrl rejects loopback/private with a plain Error before
    // we ever reach the dispatcher's WebhookDeliveryError mapping.
    await expect(deliverWebhook(job)).rejects.toThrow(/private range|loopback/i);
  });

  test('allowPrivateIps=true bypasses validation but logs a warning', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    const job = {
      id: 'job-2',
      deliveryId: 'd2',
      endpointId: 'ep2',
      url: 'http://127.0.0.1/hook',
      secret: 'x',
      event: 'evt' as never,
      eventId: 'e1',
      occurredAt: new Date().toISOString(),
      subscriber: { ownerType: 'tenant' as const, ownerId: 't', tenantId: 't' },
      payload: '{}',
      attempts: 0,
      createdAt: new Date(),
    };
    await deliverWebhook(job, {
      allowPrivateIps: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.some(c =>
      String(c[0]).includes('allowPrivateIps=true bypassed SSRF protection'),
    );
    expect(warned).toBe(true);
    warnSpy.mockRestore();
  });
});
