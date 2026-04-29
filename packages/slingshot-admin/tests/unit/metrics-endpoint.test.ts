/**
 * Tests for the admin metrics collector and endpoint.
 *
 * Covers metrics collection, reset, and the snapshot shape.
 */
import { describe, expect, test } from 'bun:test';
import { createAdminMetricsCollector } from '../../src/lib/metrics';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAdminMetricsCollector', () => {
  test('starts with all counters at zero', () => {
    const collector = createAdminMetricsCollector();
    const metrics = collector.getMetrics();

    expect(metrics.requestCount).toBe(0);
    expect(metrics.errorCount).toBe(0);
    expect(metrics.providerCalls).toEqual({});
    expect(metrics.providerFailures).toEqual({});
    expect(metrics.rateLimitHitCount).toBe(0);
  });

  test('incrementRequestCount increases request count', () => {
    const collector = createAdminMetricsCollector();

    collector.incrementRequestCount();
    expect(collector.getMetrics().requestCount).toBe(1);

    collector.incrementRequestCount();
    expect(collector.getMetrics().requestCount).toBe(2);
  });

  test('incrementErrorCount increases error count', () => {
    const collector = createAdminMetricsCollector();

    collector.incrementErrorCount();
    expect(collector.getMetrics().errorCount).toBe(1);
  });

  test('recordProviderCall tracks calls by provider method name', () => {
    const collector = createAdminMetricsCollector();

    collector.recordProviderCall('auth0:verifyRequest');
    collector.recordProviderCall('auth0:verifyRequest');
    collector.recordProviderCall('memory:listUsers');

    const metrics = collector.getMetrics();
    expect(metrics.providerCalls['auth0:verifyRequest']).toBe(2);
    expect(metrics.providerCalls['memory:listUsers']).toBe(1);
  });

  test('recordProviderFailure tracks failures by provider method name', () => {
    const collector = createAdminMetricsCollector();

    collector.recordProviderFailure('auth0:verifyRequest');
    collector.recordProviderFailure('auth0:verifyRequest');

    const metrics = collector.getMetrics();
    expect(metrics.providerFailures['auth0:verifyRequest']).toBe(2);
  });

  test('incrementRateLimitHit increases rate limit counter', () => {
    const collector = createAdminMetricsCollector();

    collector.incrementRateLimitHit();
    expect(collector.getMetrics().rateLimitHitCount).toBe(1);
  });

  test('reset clears all counters', () => {
    const collector = createAdminMetricsCollector();

    collector.incrementRequestCount();
    collector.incrementErrorCount();
    collector.recordProviderCall('auth0:verifyRequest');
    collector.recordProviderFailure('auth0:verifyRequest');
    collector.incrementRateLimitHit();

    collector.reset();

    const metrics = collector.getMetrics();
    expect(metrics.requestCount).toBe(0);
    expect(metrics.errorCount).toBe(0);
    expect(metrics.providerCalls).toEqual({});
    expect(metrics.providerFailures).toEqual({});
    expect(metrics.rateLimitHitCount).toBe(0);
  });

  test('getMetrics returns a snapshot (independent of subsequent mutations)', () => {
    const collector = createAdminMetricsCollector();

    collector.incrementRequestCount();
    const snapshot = collector.getMetrics();
    expect(snapshot.requestCount).toBe(1);

    // Mutating the collector should not affect the snapshot
    collector.incrementRequestCount();
    expect(snapshot.requestCount).toBe(1); // unchanged
    expect(collector.getMetrics().requestCount).toBe(2);
  });

  test('handles large numbers of provider calls', () => {
    const collector = createAdminMetricsCollector();

    for (let i = 0; i < 1000; i++) {
      collector.recordProviderCall('auth0:verifyRequest');
    }

    expect(collector.getMetrics().providerCalls['auth0:verifyRequest']).toBe(1000);
  });
});
