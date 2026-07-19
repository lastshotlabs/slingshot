import { describe, expect, test } from 'bun:test';
import {
  billingPackageConfigSchema,
  createBillingPackage,
  isBillingConfigured,
} from '../../src/index';

describe('billingPackageConfigSchema', () => {
  test('accepts a minimal (dormant) config and applies defaults', () => {
    const config = billingPackageConfigSchema.parse({});
    expect(config.mountPath).toBe('/billing');
    expect(config.provider).toBeUndefined();
    expect(config.plans).toEqual([]);
    expect(config.donations.enabled).toBe(false);
    expect(config.donations.requireAuth).toBe(true);
  });

  test("rejects a mountPath of '/'", () => {
    expect(() => billingPackageConfigSchema.parse({ mountPath: '/' })).toThrow();
  });

  test('rejects a stripe provider missing its secrets', () => {
    expect(() =>
      billingPackageConfigSchema.parse({ provider: { name: 'stripe', secretKey: '' } }),
    ).toThrow();
  });

  test('normalizes a trailing slash on mountPath', () => {
    expect(billingPackageConfigSchema.parse({ mountPath: '/pay/' }).mountPath).toBe('/pay');
  });
});

describe('isBillingConfigured (dormant gate)', () => {
  test('false when no provider is configured', () => {
    expect(isBillingConfigured(billingPackageConfigSchema.parse({}))).toBe(false);
  });

  test('true when a stripe provider with both secrets is present', () => {
    const config = billingPackageConfigSchema.parse({
      provider: { name: 'stripe', secretKey: 'sk_test_x', webhookSecret: 'whsec_x' },
      urls: {
        checkoutSuccess: 'https://app.test/ok',
        checkoutCancel: 'https://app.test/no',
        portalReturn: 'https://app.test/settings',
      },
    });
    expect(isBillingConfigured(config)).toBe(true);
  });
});

describe('createBillingPackage', () => {
  test('returns a valid package definition with a CSRF-exempt webhook path', () => {
    const pkg = createBillingPackage({});
    expect(pkg.name).toBe('slingshot-billing');
    expect(pkg.mountPath).toBe('/billing');
    expect(pkg.csrfExemptPaths).toContain('/billing/webhooks/stripe');
    expect(pkg.publicPaths).toContain('/billing/webhooks/stripe');
  });

  test('honors a custom mountPath in the webhook path', () => {
    const pkg = createBillingPackage({ mountPath: '/pay' });
    expect(pkg.csrfExemptPaths).toContain('/pay/webhooks/stripe');
  });
});
