/**
 * Unified metrics emitter contract.
 *
 * Thin, dependency-free interface that prod-track packages call to record
 * counters, gauges, and timings without coupling to a specific backend
 * (Prometheus, OpenTelemetry, etc). Defaults to a no-op so packages can emit
 * unconditionally and let the host application decide whether and where to
 * collect.
 *
 * This is a **separate seam** from the framework-owned `MetricsState`
 * (Prometheus-style registry used by the built-in `/metrics` HTTP endpoint).
 * Plugins should prefer this `MetricsEmitter` for ad-hoc operational signals;
 * the framework metrics plugin remains the home for the request-level
 * counters/histograms exposed at the scrape endpoint.
 */

/**
 * Pluggable metrics sink for plugin-emitted counters, gauges, and timings.
 *
 * Implementations must be safe to call from hot paths — no I/O, no allocation
 * spikes, and no exceptions. Failed writes should be swallowed; metrics are
 * best-effort observability, not critical correctness.
 *
 * @remarks
 * **Naming convention** — names should follow `<package>.<area>.<metric>` form
 * (e.g. `search.query.count`, `notifications.delivery.duration`). Labels carry
 * dimensions (provider, status, tenant). Keep label cardinality low — every
 * unique label combination is a distinct time-series.
 */
export interface MetricsEmitter {
  /**
   * Record a counter increment.
   *
   * Counters are monotonic — they only go up. Use a counter for "how many
   * times did X happen", not for "what's the current value of X" (that is a
   * gauge).
   *
   * @param name - Metric name (e.g. `search.query.count`).
   * @param value - Increment amount. Defaults to `1`. Negative values are
   *   undefined behavior — implementations may clamp to zero or treat as a
   *   no-op.
   * @param labels - Optional label key/value map. Empty object is equivalent
   *   to omitting the parameter.
   */
  counter(name: string, value?: number, labels?: Record<string, string>): void;

  /**
   * Record a gauge sample.
   *
   * Gauges represent point-in-time values that can move both directions
   * (queue depth, in-flight requests, circuit breaker state). The latest
   * write wins — earlier samples for the same name+labels are overwritten.
   *
   * @param name - Metric name (e.g. `search.eventSync.dlq.size`).
   * @param value - Current value. Any finite number is allowed.
   * @param labels - Optional label key/value map.
   */
  gauge(name: string, value: number, labels?: Record<string, string>): void;

  /**
   * Record a timing sample in milliseconds.
   *
   * Implementations may aggregate samples into a histogram or reservoir for
   * percentile estimation. Always pass milliseconds — never seconds — so all
   * emitters share a unit.
   *
   * @param name - Metric name (e.g. `search.query.duration`).
   * @param ms - Duration in milliseconds. Negative values are undefined
   *   behavior.
   * @param labels - Optional label key/value map.
   */
  timing(name: string, ms: number, labels?: Record<string, string>): void;
}

// ============================================================================
// No-op emitter
// ============================================================================

/**
 * Create a no-op `MetricsEmitter`.
 *
 * Used as the default when the host application has not configured a metrics
 * backend. Every method is a constant-time no-op so callers can emit
 * unconditionally without checking for a configured emitter first.
 *
 * @returns A frozen emitter whose methods do nothing.
 */
export function createNoopMetricsEmitter(): MetricsEmitter {
  return Object.freeze({
    counter(): void {
      /* no-op */
    },
    gauge(): void {
      /* no-op */
    },
    timing(): void {
      /* no-op */
    },
  });
}

// ============================================================================
// In-process emitter (test / single-instance use)
// ============================================================================

/**
 * Aggregated counter entry in a `MetricsSnapshot`.
 */
export interface CounterSnapshotEntry {
  /** Metric name. */
  readonly name: string;
  /** Label set associated with this aggregated value. */
  readonly labels: Readonly<Record<string, string>>;
  /** Cumulative count. */
  readonly value: number;
}

/**
 * Aggregated gauge entry in a `MetricsSnapshot`.
 */
export interface GaugeSnapshotEntry {
  /** Metric name. */
  readonly name: string;
  /** Label set associated with this gauge sample. */
  readonly labels: Readonly<Record<string, string>>;
  /** Last-write-wins value. */
  readonly value: number;
}

/**
 * Aggregated timing entry in a `MetricsSnapshot`.
 */
export interface TimingSnapshotEntry {
  /** Metric name. */
  readonly name: string;
  /** Label set associated with this timing series. */
  readonly labels: Readonly<Record<string, string>>;
  /** Number of samples recorded. */
  readonly count: number;
  /** Sum of all sample values (used to derive average if desired). */
  readonly sum: number;
  /** Minimum sample value. */
  readonly min: number;
  /** Maximum sample value. */
  readonly max: number;
  /** Approximate p50 (median) of recorded samples. */
  readonly p50: number;
  /** Approximate p95 of recorded samples. */
  readonly p95: number;
  /** Approximate p99 of recorded samples. */
  readonly p99: number;
}

/**
 * Serializable point-in-time snapshot of an in-process metrics emitter.
 */
export interface MetricsSnapshot {
  /** All counter time-series. */
  readonly counters: ReadonlyArray<CounterSnapshotEntry>;
  /** All gauge time-series. */
  readonly gauges: ReadonlyArray<GaugeSnapshotEntry>;
  /** All timing time-series with derived percentiles. */
  readonly timings: ReadonlyArray<TimingSnapshotEntry>;
}

/**
 * In-process `MetricsEmitter` plus a `snapshot()` accessor.
 */
export interface InProcessMetricsEmitter extends MetricsEmitter {
  /**
   * Capture a serializable snapshot of all aggregated metrics. Reading the
   * snapshot does not mutate the underlying state — call `reset()` to clear.
   */
  snapshot(): MetricsSnapshot;
  /** Reset all aggregated state. Useful in tests. */
  reset(): void;
}

interface CounterCell {
  labels: Record<string, string>;
  value: number;
}

interface GaugeCell {
  labels: Record<string, string>;
  value: number;
}

interface TimingCell {
  labels: Record<string, string>;
  /** Reservoir of recorded samples, capped to `RESERVOIR_LIMIT`. */
  samples: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
}

/**
 * Reservoir cap per (name, label-set). Bounded so a long-running process can
 * keep aggregating timing samples without unbounded memory growth. When the
 * cap is reached, new samples replace random earlier samples (Vitter's
 * Algorithm R, simplified). The percentile estimates remain unbiased.
 */
const RESERVOIR_LIMIT = 1024;

/**
 * Maximum number of unique label sets retained per metric name (per kind).
 * Once a metric reaches this cap, additional label combinations are silently
 * dropped — better to lose visibility into outliers than to leak memory when
 * a caller accidentally puts a high-cardinality value (request id, user id)
 * into a label.
 */
const LABEL_CARDINALITY_LIMIT = 1000;

function fingerprintLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  let out = '';
  for (const k of keys) {
    if (out.length > 0) out += ',';
    out += `${k}=${labels[k]}`;
  }
  return out;
}

function freezeLabels(labels: Record<string, string> | undefined): Record<string, string> {
  if (!labels) return Object.freeze({});
  return Object.freeze({ ...labels });
}

function percentile(sortedSamples: number[], p: number): number {
  if (sortedSamples.length === 0) return 0;
  if (sortedSamples.length === 1) return sortedSamples[0];
  // Nearest-rank percentile (1-based, clamped to last index).
  const rank = Math.ceil((p / 100) * sortedSamples.length);
  const idx = Math.max(0, Math.min(sortedSamples.length - 1, rank - 1));
  return sortedSamples[idx];
}

/**
 * Create an in-process `MetricsEmitter` that aggregates counters, gauges, and
 * timings into a memory-resident snapshot.
 *
 * Aggregation rules:
 * - **Counters** add — repeated calls with the same name+labels accumulate.
 * - **Gauges** are last-write-wins — only the most recent value is retained.
 * - **Timings** record into a bounded reservoir (`RESERVOIR_LIMIT` samples per
 *   series). Snapshots derive p50/p95/p99 + count/sum/min/max from the
 *   reservoir at read time.
 *
 * Designed for tests and single-instance deployments. For production, prefer
 * a backend-specific emitter (Prometheus, OTel) so metrics survive process
 * restarts and can be aggregated across instances.
 *
 * @returns An emitter with `snapshot()` and `reset()` accessors. Methods are
 *   safe to call concurrently with `snapshot()` — snapshots are best-effort
 *   point-in-time views and may include partial concurrent writes.
 */
export function createInProcessMetricsEmitter(): InProcessMetricsEmitter {
  // Outer key: metric name. Inner key: label fingerprint.
  const counters = new Map<string, Map<string, CounterCell>>();
  const gauges = new Map<string, Map<string, GaugeCell>>();
  const timings = new Map<string, Map<string, TimingCell>>();
  // Track which (kind, name) pairs have already logged a cardinality cap
  // warning so we don't spam the console when a high-cardinality label is
  // accidentally used on a hot path.
  const cardinalityCapWarned = new Set<string>();

  function warnCardinalityCap(kind: 'counter' | 'gauge' | 'timing', name: string): void {
    const key = `${kind}:${name}`;
    if (cardinalityCapWarned.has(key)) return;
    cardinalityCapWarned.add(key);
    console.warn(
      `[slingshot-core/metrics] ${kind} '${name}' reached the per-metric label cardinality cap ` +
        `(${LABEL_CARDINALITY_LIMIT} unique label sets). Additional label combinations will be ` +
        `dropped. Check that no high-cardinality value (request id, user id, full URL) is being ` +
        `passed as a label.`,
    );
  }

  function counterImpl(name: string, value: number = 1, labels?: Record<string, string>): void {
    if (!Number.isFinite(value)) return;
    let series = counters.get(name);
    if (!series) {
      series = new Map();
      counters.set(name, series);
    }
    const fp = fingerprintLabels(labels);
    const cell = series.get(fp);
    if (cell) {
      cell.value += value;
      return;
    }
    if (series.size >= LABEL_CARDINALITY_LIMIT) {
      warnCardinalityCap('counter', name);
      return;
    }
    series.set(fp, { labels: freezeLabels(labels), value });
  }

  function gaugeImpl(name: string, value: number, labels?: Record<string, string>): void {
    if (!Number.isFinite(value)) return;
    let series = gauges.get(name);
    if (!series) {
      series = new Map();
      gauges.set(name, series);
    }
    const fp = fingerprintLabels(labels);
    const cell = series.get(fp);
    if (cell) {
      cell.value = value;
      return;
    }
    if (series.size >= LABEL_CARDINALITY_LIMIT) {
      warnCardinalityCap('gauge', name);
      return;
    }
    series.set(fp, { labels: freezeLabels(labels), value });
  }

  function timingImpl(name: string, ms: number, labels?: Record<string, string>): void {
    if (!Number.isFinite(ms)) return;
    let series = timings.get(name);
    if (!series) {
      series = new Map();
      timings.set(name, series);
    }
    const fp = fingerprintLabels(labels);
    let cell = series.get(fp);
    if (!cell) {
      if (series.size >= LABEL_CARDINALITY_LIMIT) {
        warnCardinalityCap('timing', name);
        return;
      }
      cell = {
        labels: freezeLabels(labels),
        samples: [],
        count: 0,
        sum: 0,
        min: ms,
        max: ms,
      };
      series.set(fp, cell);
    }
    cell.count += 1;
    cell.sum += ms;
    if (ms < cell.min) cell.min = ms;
    if (ms > cell.max) cell.max = ms;
    if (cell.samples.length < RESERVOIR_LIMIT) {
      cell.samples.push(ms);
    } else {
      // Reservoir replacement — pick a uniformly random index in [0, count).
      // If it falls inside the reservoir, replace; otherwise drop.
      const idx = Math.floor(Math.random() * cell.count);
      if (idx < RESERVOIR_LIMIT) {
        cell.samples[idx] = ms;
      }
    }
  }

  function snapshotImpl(): MetricsSnapshot {
    const counterEntries: CounterSnapshotEntry[] = [];
    for (const [name, series] of counters) {
      for (const cell of series.values()) {
        counterEntries.push({ name, labels: cell.labels, value: cell.value });
      }
    }
    const gaugeEntries: GaugeSnapshotEntry[] = [];
    for (const [name, series] of gauges) {
      for (const cell of series.values()) {
        gaugeEntries.push({ name, labels: cell.labels, value: cell.value });
      }
    }
    const timingEntries: TimingSnapshotEntry[] = [];
    for (const [name, series] of timings) {
      for (const cell of series.values()) {
        const sorted = [...cell.samples].sort((a, b) => a - b);
        timingEntries.push({
          name,
          labels: cell.labels,
          count: cell.count,
          sum: cell.sum,
          min: cell.min,
          max: cell.max,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
        });
      }
    }
    return Object.freeze({
      counters: Object.freeze(counterEntries),
      gauges: Object.freeze(gaugeEntries),
      timings: Object.freeze(timingEntries),
    });
  }

  function resetImpl(): void {
    counters.clear();
    gauges.clear();
    timings.clear();
    cardinalityCapWarned.clear();
  }

  return {
    counter: counterImpl,
    gauge: gaugeImpl,
    timing: timingImpl,
    snapshot: snapshotImpl,
    reset: resetImpl,
  };
}
