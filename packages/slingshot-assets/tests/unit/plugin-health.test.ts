import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, mock, test } from 'bun:test';
import type {
  PackageCapabilityHandle,
  PublishedPackageCapability,
} from '@lastshotlabs/slingshot-core';
import type { AssetsHealth } from '../../src/types';

let sendShouldFail = false;
let capturedSendError: Error | null = null;

mock.module('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(_opts: Record<string, unknown>) {}
    async send(_command: unknown): Promise<{}> {
      if (sendShouldFail) throw capturedSendError ?? new Error('S3 unavailable');
      return {};
    }
  }
  class PutObjectCommand {
    constructor(_params: Record<string, unknown>) {}
  }
  class GetObjectCommand {
    constructor(_params: Record<string, unknown>) {}
  }
  class DeleteObjectCommand {
    constructor(_params: Record<string, unknown>) {}
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

const { createAssetsPackage } = await import('../../src/plugin');
const { AssetsHealthCap } = await import('../../src/public');
const { s3Storage } = await import('../../src/adapters/s3');
const { createMemoryImageCache } = await import('../../src/image/cache');

const fakeData = Buffer.from([1, 2, 3]);
const fakeMeta = { mimeType: 'application/octet-stream', size: 3 };

/**
 * Resolve the package's published `AssetsHealthCap` value directly off the
 * `SlingshotPackageDefinition` — bypasses createApp / capabilities registry.
 */
async function resolveHealthCap(
  pkg: ReturnType<typeof createAssetsPackage>,
): Promise<() => AssetsHealth> {
  const provider = pkg.capabilities.provides.find(
    (p: PublishedPackageCapability<unknown>) =>
      (p.capability as PackageCapabilityHandle<unknown>).name ===
      (AssetsHealthCap as PackageCapabilityHandle<unknown>).name,
  );
  if (!provider) throw new Error('AssetsHealthCap not published by package');
  const value = await provider.resolve({ packageName: pkg.name });
  return value as () => AssetsHealth;
}

beforeEach(() => {
  sendShouldFail = false;
  capturedSendError = null;
});

afterEach(() => {
  mock.restore();
});

describe('createAssetsPackage AssetsHealthCap', () => {
  it('reports healthy with a memory adapter and no image cache', async () => {
    const pkg = createAssetsPackage({ storage: { adapter: 'memory' } });
    const getHealth = await resolveHealthCap(pkg);
    const health = getHealth();
    expect(health.status).toBe('healthy');
    expect(health.details.storageAdapter).toBe('memory');
    expect(health.details.storageConfigured).toBe(true);
    // The memory adapter now exposes circuit breaker health for consistency
    expect(health.details.storageCircuitBreaker).toBeDefined();
    expect(health.details.storageCircuitBreaker?.state).toBe('closed');
    expect(health.details.imageCache).toBeUndefined();
  });

  it('includes image cache size and eviction count when image transforms are enabled', async () => {
    const cache = createMemoryImageCache({ maxEntries: 1 });
    const pkg = createAssetsPackage({
      storage: { adapter: 'memory' },
      image: { maxWidth: 1024, maxHeight: 1024, cache },
    });
    const getHealth = await resolveHealthCap(pkg);

    // Initial state: empty cache, no evictions
    let health = getHealth();
    expect(health.details.imageCache?.size).toBe(0);
    expect(health.details.imageCache?.evictionCount).toBe(0);
    expect(health.details.imageCache?.ttlEvictionCount).toBe(0);

    // Insert two entries to force one eviction at maxEntries: 1.
    const entry = {
      buffer: new ArrayBuffer(4),
      contentType: 'image/png',
      generatedAt: Date.now(),
    };
    await cache.set('a', entry);
    await cache.set('b', entry);

    health = getHealth();
    expect(health.details.imageCache?.size).toBe(1);
    expect(health.details.imageCache?.evictionCount).toBe(1);
  });

  test('bubbles S3 circuit breaker state through AssetsHealthCap', async () => {
    sendShouldFail = true;
    let nowMs = 1_000_000;
    const adapter = s3Storage({
      bucket: 'b',
      retryAttempts: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    const pkg = createAssetsPackage({ storage: adapter });
    const getHealth = await resolveHealthCap(pkg);

    // Closed initially
    let health = getHealth();
    expect(health.status).toBe('healthy');
    expect(health.details.storageAdapter).toBe('custom');
    expect(health.details.storageCircuitBreaker?.state).toBe('closed');
    expect(health.details.storageCircuitBreaker?.consecutiveFailures).toBe(0);

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(adapter.put(`k-${i}`, fakeData, fakeMeta)).rejects.toThrow();
      nowMs += 10;
    }

    health = getHealth();
    expect(health.status).toBe('unhealthy');
    expect(health.details.storageCircuitBreaker?.state).toBe('open');
    expect(health.details.storageCircuitBreaker?.consecutiveFailures).toBe(3);
    expect(health.details.storageCircuitBreaker?.openedAt).toBeDefined();
  });
});
