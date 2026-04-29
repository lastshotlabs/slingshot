import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createInProcessMetricsEmitter, createNoopMetricsEmitter } from '../../src/metrics';

// ---------------------------------------------------------------------------
// No-op emitter
// ---------------------------------------------------------------------------

describe('createNoopMetricsEmitter', () => {
  test('exposes counter/gauge/timing as constant-time no-ops', () => {
    const emitter = createNoopMetricsEmitter();
    expect(() => emitter.counter('a')).not.toThrow();
    expect(() => emitter.counter('a', 5, { provider: 'x' })).not.toThrow();
    expect(() => emitter.gauge('b', 1)).not.toThrow();
    expect(() => emitter.timing('c', 12.5)).not.toThrow();
  });

  test('returns a frozen emitter', () => {
    const emitter = createNoopMetricsEmitter();
    expect(Object.isFrozen(emitter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In-process emitter — counter semantics
// ---------------------------------------------------------------------------

describe('createInProcessMetricsEmitter — counter', () => {
  test('repeated calls with same name+labels accumulate', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.counter('search.query.count', 1, { provider: 'meili' });
    emitter.counter('search.query.count', 2, { provider: 'meili' });
    emitter.counter('search.query.count', undefined, { provider: 'meili' });
    const snap = emitter.snapshot();
    expect(snap.counters).toHaveLength(1);
    expect(snap.counters[0]).toMatchObject({
      name: 'search.query.count',
      value: 4,
      labels: { provider: 'meili' },
    });
  });

  test('default value is 1 when omitted', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.counter('a');
    emitter.counter('a');
    const snap = emitter.snapshot();
    expect(snap.counters[0].value).toBe(2);
  });

  test('different label sets create independent series', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.counter('search.query.count', 1, { provider: 'meili' });
    emitter.counter('search.query.count', 1, { provider: 'typesense' });
    const snap = emitter.snapshot();
    expect(snap.counters).toHaveLength(2);
    const meili = snap.counters.find(c => c.labels.provider === 'meili');
    const typesense = snap.counters.find(c => c.labels.provider === 'typesense');
    expect(meili?.value).toBe(1);
    expect(typesense?.value).toBe(1);
  });

  test('label key order is normalized via stable fingerprint', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.counter('m', 1, { a: '1', b: '2' });
    emitter.counter('m', 1, { b: '2', a: '1' });
    const snap = emitter.snapshot();
    expect(snap.counters).toHaveLength(1);
    expect(snap.counters[0].value).toBe(2);
  });

  test('non-finite values are silently dropped', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.counter('a', Number.NaN);
    emitter.counter('a', Number.POSITIVE_INFINITY);
    expect(emitter.snapshot().counters).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// In-process emitter — gauge semantics
// ---------------------------------------------------------------------------

describe('createInProcessMetricsEmitter — gauge', () => {
  test('last write wins for the same name+labels', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.gauge('queue.depth', 10);
    emitter.gauge('queue.depth', 20);
    emitter.gauge('queue.depth', 5);
    const snap = emitter.snapshot();
    expect(snap.gauges).toHaveLength(1);
    expect(snap.gauges[0].value).toBe(5);
  });

  test('different label sets are tracked independently', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.gauge('cb.state', 0, { provider: 'meili' });
    emitter.gauge('cb.state', 1, { provider: 'typesense' });
    const snap = emitter.snapshot();
    expect(snap.gauges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// In-process emitter — timing semantics
// ---------------------------------------------------------------------------

describe('createInProcessMetricsEmitter — timing', () => {
  test('records count, sum, min, max across samples', () => {
    const emitter = createInProcessMetricsEmitter();
    for (const ms of [5, 10, 15, 20]) emitter.timing('q', ms);
    const snap = emitter.snapshot();
    const t = snap.timings[0];
    expect(t.count).toBe(4);
    expect(t.sum).toBe(50);
    expect(t.min).toBe(5);
    expect(t.max).toBe(20);
  });

  test('p50/p95/p99 on 1000 evenly-spaced samples', () => {
    const emitter = createInProcessMetricsEmitter();
    // Insert 1..1000 ms in sorted order. Reservoir cap is 1024 so all samples
    // are retained without random replacement, keeping the percentile output
    // deterministic for assertion.
    for (let i = 1; i <= 1000; i++) emitter.timing('q', i);
    const snap = emitter.snapshot();
    const t = snap.timings[0];
    expect(t.count).toBe(1000);
    // Nearest-rank percentile on 1..1000 — rank = ceil(p/100 * 1000).
    expect(t.p50).toBe(500);
    expect(t.p95).toBe(950);
    expect(t.p99).toBe(990);
  });

  test('reservoir cap is bounded at 1024 samples per series', () => {
    const emitter = createInProcessMetricsEmitter();
    for (let i = 0; i < 5000; i++) emitter.timing('q', i);
    const snap = emitter.snapshot();
    // We can't introspect samples length directly through the snapshot, but
    // count/sum should reflect every observation while p50/p95/p99 stay
    // bounded by the reservoir of size 1024.
    expect(snap.timings[0].count).toBe(5000);
    expect(snap.timings[0].p50).toBeGreaterThanOrEqual(0);
    expect(snap.timings[0].p99).toBeLessThanOrEqual(5000);
  });
});

// ---------------------------------------------------------------------------
// In-process emitter — label cardinality cap
// ---------------------------------------------------------------------------

describe('createInProcessMetricsEmitter — label cardinality cap', () => {
  let warnSpy: ReturnType<typeof spyOn> | undefined;
  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy?.mockRestore();
  });

  test('drops new label sets beyond the 1000-cap and warns once per metric', () => {
    const emitter = createInProcessMetricsEmitter();
    // Insert 1500 unique label combinations; only 1000 should be retained.
    for (let i = 0; i < 1500; i++) {
      emitter.counter('high.cardinality', 1, { id: String(i) });
    }
    const snap = emitter.snapshot();
    const matching = snap.counters.filter(c => c.name === 'high.cardinality');
    expect(matching.length).toBe(1000);
    // One warning for this counter — even after 500 dropped writes.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = (warnSpy?.mock.calls[0]?.[0] ?? '') as string;
    expect(message).toContain("counter 'high.cardinality'");
    expect(message).toContain('1000');
  });

  test('cap applies independently per (kind, name) pair', () => {
    const emitter = createInProcessMetricsEmitter();
    for (let i = 0; i < 1100; i++) {
      emitter.counter('a', 1, { id: String(i) });
      emitter.gauge('a', 1, { id: String(i) });
    }
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('reset clears the warned set so future cap hits warn again', () => {
    const emitter = createInProcessMetricsEmitter();
    for (let i = 0; i < 1100; i++) emitter.counter('a', 1, { id: String(i) });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    emitter.reset();
    for (let i = 0; i < 1100; i++) emitter.counter('a', 1, { id: String(i) });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Snapshot / reset
// ---------------------------------------------------------------------------

describe('createInProcessMetricsEmitter — snapshot/reset', () => {
  test('snapshot is non-destructive — repeated reads return identical values', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.counter('a', 5);
    const a = emitter.snapshot();
    const b = emitter.snapshot();
    expect(a.counters[0].value).toBe(5);
    expect(b.counters[0].value).toBe(5);
  });

  test('reset clears all counters/gauges/timings', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.counter('a');
    emitter.gauge('b', 1);
    emitter.timing('c', 1);
    emitter.reset();
    const snap = emitter.snapshot();
    expect(snap.counters).toHaveLength(0);
    expect(snap.gauges).toHaveLength(0);
    expect(snap.timings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Smoke: snapshot is JSON-serializable
// ---------------------------------------------------------------------------

describe('MetricsSnapshot serialization', () => {
  test('snapshot can be JSON.stringify-ed without throwing', () => {
    const emitter = createInProcessMetricsEmitter();
    emitter.counter('a', 1, { x: '1' });
    emitter.gauge('b', 2, { y: '2' });
    emitter.timing('c', 3.5);
    const snap = emitter.snapshot();
    const json = JSON.stringify(snap);
    expect(typeof json).toBe('string');
    expect(json.length).toBeGreaterThan(0);
  });
});

// Suppress unused-import lint (mock isn't needed but is a common bun:test idiom).
void mock;
