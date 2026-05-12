import { describe, expect, it } from 'bun:test';
import { createWebhooksPackage } from '../../src/plugin';
import { WEBHOOK_ROUTES } from '../../src/routes';
import type { InboundProvider } from '../../src/types/inbound';

const provider: InboundProvider = {
  name: 'stripe',
  verify: async () => ({ verified: true, payload: {} }),
};

describe('createWebhooksPackage', () => {
  it('does not expose inbound paths when no inbound providers are configured', () => {
    const pkg = createWebhooksPackage({});

    expect(pkg.publicPaths).toEqual([]);
    expect(pkg.csrfExemptPaths).toEqual([]);
  });

  it('does not expose inbound paths when inbound routes are disabled', () => {
    const pkg = createWebhooksPackage({
      inbound: [provider],
      disableRoutes: [WEBHOOK_ROUTES.INBOUND],
    });

    expect(pkg.publicPaths).toEqual([]);
    expect(pkg.csrfExemptPaths).toEqual([]);
  });

  it('normalizes trailing slashes in mountPath before building inbound paths', () => {
    const pkg = createWebhooksPackage({
      inbound: [provider],
      mountPath: '/custom/hooks/',
    });

    expect(pkg.publicPaths).toEqual(['/custom/hooks/inbound/*']);
    expect(pkg.csrfExemptPaths).toEqual(['/custom/hooks/inbound/*']);
  });

  it('rejects mountPath values without a leading slash', () => {
    expect(() =>
      createWebhooksPackage({
        mountPath: 'custom/hooks',
      }),
    ).toThrow(/mountPath must start with '\//i);
  });

  it('requires a durable bus subscription name when durability is enabled', () => {
    expect(() =>
      createWebhooksPackage({
        busSubscription: {
          durable: true,
        },
      }),
    ).toThrow(/busSubscription\.name is required/i);
  });

  it('requires endpoint secret encryption in production unless explicitly opted out', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const pkg = createWebhooksPackage({});
      await expect(
        pkg.setupMiddleware?.({
          app: {} as never,
          config: {} as never,
          bus: {} as never,
          events: {} as never,
        }),
      ).rejects.toThrow(/secret encryption is required in production/i);
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });
});
