import { beforeEach, describe, expect, test } from 'bun:test';
import {
  closeMetricsQueues,
  createMetricsState,
  defaultNormalizePath,
  incrementCounter,
  observeHistogram,
  registerGaugeCallback,
  resetMetrics,
  serializeMetrics,
  setMetricsQueues,
} from '../../src/framework/metrics/registry';

const state = createMetricsState();

beforeEach(() => {
  resetMetrics(state);
});

// ── Counter ──────────────────────────────────────────────────────────────────

describe('incrementCounter', () => {
  test('increments a counter with labels', async () => {
    incrementCounter(state, 'http_requests_total', {
      method: 'GET',
      path: '/users',
      status: '200',
    });
    incrementCounter(state, 'http_requests_total', {
      method: 'GET',
      path: '/users',
      status: '200',
    });
    incrementCounter(state, 'http_requests_total', {
      method: 'POST',
      path: '/users',
      status: '201',
    });

    const output = await serializeMetrics(state);
    expect(output).toContain('http_requests_total{method="GET",path="/users",status="200"} 2');
    expect(output).toContain('http_requests_total{method="POST",path="/users",status="201"} 1');
  });

  test('increments by custom amount', async () => {
    incrementCounter(state, 'errors_total', { type: 'timeout' }, 5);
    const output = await serializeMetrics(state);
    expect(output).toContain('errors_total{type="timeout"} 5');
  });
});

// ── Histogram ────────────────────────────────────────────────────────────────

describe('observeHistogram', () => {
  test('distributes values into buckets', async () => {
    // Observe some values
    observeHistogram(
      state,
      'http_request_duration_seconds',
      { method: 'GET', path: '/api' },
      0.003,
    );
    observeHistogram(state, 'http_request_duration_seconds', { method: 'GET', path: '/api' }, 0.05);
    observeHistogram(state, 'http_request_duration_seconds', { method: 'GET', path: '/api' }, 0.5);
    observeHistogram(state, 'http_request_duration_seconds', { method: 'GET', path: '/api' }, 2.0);

    const output = await serializeMetrics(state);

    // Check TYPE line
    expect(output).toContain('# TYPE http_request_duration_seconds histogram');

    // 0.003 fits in le=0.005 bucket
    expect(output).toContain(
      'http_request_duration_seconds_bucket{le="0.005",method="GET",path="/api"} 1',
    );
    // cumulative: 0.003 + 0.05 fit in le=0.05
    expect(output).toContain(
      'http_request_duration_seconds_bucket{le="0.05",method="GET",path="/api"} 2',
    );
    // cumulative: +0.5 fits in le=0.5
    expect(output).toContain(
      'http_request_duration_seconds_bucket{le="0.5",method="GET",path="/api"} 3',
    );
    // +Inf has all 4
    expect(output).toContain(
      'http_request_duration_seconds_bucket{le="+Inf",method="GET",path="/api"} 4',
    );

    // sum and count
    expect(output).toContain('http_request_duration_seconds_sum{method="GET",path="/api"} 2.553');
    expect(output).toContain('http_request_duration_seconds_count{method="GET",path="/api"} 4');
  });
});

// ── serializeMetrics ─────────────────────────────────────────────────────────

describe('serializeMetrics', () => {
  test('produces valid Prometheus text format', async () => {
    incrementCounter(state, 'test_counter', { label: 'a' });
    const output = await serializeMetrics(state);
    expect(output).toContain('# HELP test_counter');
    expect(output).toContain('# TYPE test_counter counter');
    expect(output).toContain('test_counter{label="a"} 1');
  });

  test('returns empty string when no metrics', async () => {
    const output = await serializeMetrics(state);
    expect(output).toBe('');
  });
});

// ── resetMetrics ─────────────────────────────────────────────────────────────

describe('resetMetrics', () => {
  test('clears all state', async () => {
    incrementCounter(state, 'c', { a: '1' });
    observeHistogram(state, 'h', { b: '2' }, 1);
    registerGaugeCallback(state, 'g', async () => [{ labels: {}, value: 1 }]);

    resetMetrics(state);
    const output = await serializeMetrics(state);
    expect(output).toBe('');
  });
});

// ── Path normalizer ──────────────────────────────────────────────────────────

describe('defaultNormalizePath', () => {
  test('replaces UUIDs with :id', () => {
    expect(defaultNormalizePath('/users/550e8400-e29b-41d4-a716-446655440000/profile')).toBe(
      '/users/:id/profile',
    );
  });

  test('replaces numeric segments with :id', () => {
    expect(defaultNormalizePath('/posts/123/comments')).toBe('/posts/:id/comments');
  });

  test('replaces MongoDB ObjectIDs with :id', () => {
    expect(defaultNormalizePath('/items/507f1f77bcf86cd799439011')).toBe('/items/:id');
  });

  test('leaves short alphanumeric slugs alone', () => {
    expect(defaultNormalizePath('/api/v2/users')).toBe('/api/v2/users');
  });

  test('leaves query-param-like paths alone', () => {
    expect(defaultNormalizePath('/search')).toBe('/search');
  });

  test('handles root path', () => {
    expect(defaultNormalizePath('/')).toBe('/');
  });
});

// ── closeMetricsQueues (lines 192-195, 198-200) ──────────────────────────────

describe('closeMetricsQueues', () => {
  test('closes all queues, clears the map, and sets queues to null', async () => {
    const closedQueues: string[] = [];
    const q1 = { close: async () => { closedQueues.push('q1'); } };
    const q2 = { close: async () => { closedQueues.push('q2'); } };

    const queueMap = new Map<string, { close(): Promise<void> }>([
      ['q1', q1],
      ['q2', q2],
    ]);
    setMetricsQueues(state, queueMap);
    expect(state.queues).not.toBeNull();

    await closeMetricsQueues(state);

    expect(closedQueues.sort()).toEqual(['q1', 'q2']);
    expect(state.queues).toBeNull();
  });

  test('does nothing when queues is null', async () => {
    // Should not throw and state remains null
    await expect(closeMetricsQueues(state)).resolves.toBeUndefined();
    expect(state.queues).toBeNull();
  });

  test('continues closing remaining queues when one close() throws (best-effort)', async () => {
    const closedQueues: string[] = [];
    const q1 = {
      close: async () => { throw new Error('q1 close failed'); },
    };
    const q2 = { close: async () => { closedQueues.push('q2'); } };

    setMetricsQueues(state, new Map([['q1', q1], ['q2', q2]]));

    await expect(closeMetricsQueues(state)).resolves.toBeUndefined();
    expect(closedQueues).toContain('q2');
    expect(state.queues).toBeNull();
  });
});

// ── Gauge callbacks ──────────────────────────────────────────────────────────

describe('gauge callbacks', () => {
  test('invoked at serialize time', async () => {
    let called = false;
    registerGaugeCallback(state, 'test_gauge', async () => {
      called = true;
      return [{ labels: { queue: 'email' }, value: 42 }];
    });

    expect(called).toBe(false);
    const output = await serializeMetrics(state);
    expect(called).toBe(true);
    expect(output).toContain('# TYPE test_gauge gauge');
    expect(output).toContain('test_gauge{queue="email"} 42');
  });

  test('error: scrape succeeds, gauge omitted, error counter incremented', async () => {
    incrementCounter(state, 'http_requests_total', { method: 'GET', path: '/', status: '200' });
    registerGaugeCallback(state, 'broken_gauge', async () => {
      throw new Error('connection refused');
    });

    const output = await serializeMetrics(state);
    // Scrape should still succeed (not throw)
    expect(output).toContain('http_requests_total');
    // Broken gauge should not appear
    expect(output).not.toContain('# TYPE broken_gauge gauge');
    // Error counter should be incremented
    expect(output).toContain('slingshot_gauge_errors_total{gauge="broken_gauge"} 1');
  });
});
