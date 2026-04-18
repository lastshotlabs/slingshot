// In-memory Prometheus-compatible metrics registry.
// Owned per app instance via MetricsState, not process-global.

type Labels = Record<string, string>;

interface CounterEntry {
  labels: Labels;
  value: number;
}

interface HistogramEntry {
  labels: Labels;
  buckets: number[];
  sum: number;
  count: number;
}

type GaugeCallback = () => Promise<{ labels: Labels; value: number }[]>;

export interface MetricsState {
  readonly counters: Map<string, Map<string, CounterEntry>>;
  readonly histograms: Map<string, { boundaries: number[]; entries: Map<string, HistogramEntry> }>;
  readonly gaugeCallbacks: Map<string, GaugeCallback>;
  queues: Map<string, { close(): Promise<void> }> | null;
}

export function createMetricsState(): MetricsState {
  return {
    counters: new Map(),
    histograms: new Map(),
    gaugeCallbacks: new Map(),
    queues: null,
  };
}

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
}

function formatLabels(labels: Labels): string {
  const pairs = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`);
  return pairs.length ? `{${pairs.join(',')}}` : '';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECTID_RE = /^[0-9a-f]{24}$/i;
const NUMERIC_RE = /^\d+$/;

export function defaultNormalizePath(path: string): string {
  return path
    .split('/')
    .map(seg => {
      if (!seg) return seg;
      if (UUID_RE.test(seg)) return ':id';
      if (OBJECTID_RE.test(seg)) return ':id';
      if (NUMERIC_RE.test(seg)) return ':id';
      return seg;
    })
    .join('/');
}

export function incrementCounter(
  state: MetricsState,
  name: string,
  labels: Labels,
  amount = 1,
): void {
  let metric = state.counters.get(name);
  if (!metric) {
    metric = new Map();
    state.counters.set(name, metric);
  }
  const key = labelKey(labels);
  const existing = metric.get(key);
  if (existing) {
    existing.value += amount;
  } else {
    metric.set(key, { labels: { ...labels }, value: amount });
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function observeHistogram(
  state: MetricsState,
  name: string,
  labels: Labels,
  value: number,
  buckets: number[] = DEFAULT_BUCKETS,
): void {
  let metric = state.histograms.get(name);
  if (!metric) {
    metric = { boundaries: buckets, entries: new Map() };
    state.histograms.set(name, metric);
  }
  const key = labelKey(labels);
  let entry = metric.entries.get(key);
  if (!entry) {
    entry = {
      labels: { ...labels },
      buckets: Array.from({ length: buckets.length }, () => 0),
      sum: 0,
      count: 0,
    };
    metric.entries.set(key, entry);
  }
  for (let i = 0; i < metric.boundaries.length; i++) {
    if (value <= metric.boundaries[i]) {
      entry.buckets[i]++;
      break;
    }
  }
  entry.sum += value;
  entry.count++;
}

export function registerGaugeCallback(state: MetricsState, name: string, cb: GaugeCallback): void {
  state.gaugeCallbacks.set(name, cb);
}

export async function serializeMetrics(state: MetricsState): Promise<string> {
  const lines: string[] = [];
  const gaugeLines: string[] = [];

  for (const [name, cb] of state.gaugeCallbacks) {
    try {
      const results = await cb();
      gaugeLines.push(`# HELP ${name} ${name.replace(/_/g, ' ')}`);
      gaugeLines.push(`# TYPE ${name} gauge`);
      for (const { labels, value } of results) {
        gaugeLines.push(`${name}${formatLabels(labels)} ${value}`);
      }
      gaugeLines.push('');
    } catch (err) {
      console.warn(`[metrics] Gauge callback "${name}" failed:`, err);
      incrementCounter(state, 'slingshot_gauge_errors_total', { gauge: name });
    }
  }

  for (const [name, entries] of state.counters) {
    lines.push(`# HELP ${name} Total ${name.replace(/_/g, ' ')}`);
    lines.push(`# TYPE ${name} counter`);
    for (const entry of entries.values()) {
      lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    lines.push('');
  }

  for (const [name, metric] of state.histograms) {
    lines.push(`# HELP ${name} ${name.replace(/_/g, ' ')}`);
    lines.push(`# TYPE ${name} histogram`);
    for (const entry of metric.entries.values()) {
      const lbls = formatLabels(entry.labels);
      let cumulative = 0;
      for (let i = 0; i < metric.boundaries.length; i++) {
        cumulative += entry.buckets[i];
        const bucketLabels = { ...entry.labels, le: String(metric.boundaries[i]) };
        lines.push(`${name}_bucket${formatLabels(bucketLabels)} ${cumulative}`);
      }
      const infLabels = { ...entry.labels, le: '+Inf' };
      lines.push(`${name}_bucket${formatLabels(infLabels)} ${entry.count}`);
      lines.push(`${name}_sum${lbls} ${entry.sum}`);
      lines.push(`${name}_count${lbls} ${entry.count}`);
    }
    lines.push('');
  }

  lines.push(...gaugeLines);
  return lines.join('\n');
}

export function resetMetrics(state: MetricsState): void {
  state.counters.clear();
  state.histograms.clear();
  state.gaugeCallbacks.clear();
}

export function setMetricsQueues(
  state: MetricsState,
  map: Map<string, { close(): Promise<void> }>,
): void {
  state.queues = map;
}

export async function closeMetricsQueues(state: MetricsState): Promise<void> {
  if (!state.queues) return;
  for (const q of state.queues.values()) {
    try {
      await q.close();
    } catch {
      // best-effort cleanup
    }
  }
  state.queues.clear();
  state.queues = null;
}
