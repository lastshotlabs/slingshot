/**
 * slingshot-kafka: produce/consume throughput benchmark
 *
 * Sets up a self-contained fake Kafka adapter (no real broker needed) that
 * simulates:
 * - Produce throughput (events/sec) — serialize + batch + buffer
 * - Consume throughput (events/sec) — deserialize + batch + process
 * - End-to-end latency (produce -> consume)
 *
 * Usage:
 *   bun run tests/bench/kafka-throughput.bench.ts        # quick mode
 *   BENCH=1 bun run tests/bench/kafka-throughput.bench.ts # full bench (50,000 events)
 */

import { performance } from 'node:perf_hooks';
import { JSON_SERIALIZER, createRawEventEnvelope } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const IS_FULL_BENCH = process.env.BENCH === '1';
const PRODUCE_COUNT = IS_FULL_BENCH ? 50_000 : 500;
const CONSUME_BATCH_SIZE = IS_FULL_BENCH ? 500 : 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computePercentiles(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatDuration(ms: number): string {
  return ms.toFixed(3);
}

// ---------------------------------------------------------------------------
// Fake Kafka adapter
//
// Simulates the Kafka produce/consume lifecycle:
//   produce: serialize payload -> queue into topic buffer -> batch
//   consume: read from topic buffer -> deserialize -> invoke handler
// ---------------------------------------------------------------------------

interface KafkaMessage {
  key: string;
  value: Uint8Array;
  headers: Record<string, string>;
  timestamp: number;
}

interface TopicBuffer {
  messages: KafkaMessage[];
}

function createFakeKafkaAdapter() {
  const topics = new Map<string, TopicBuffer>();
  const serializer = JSON_SERIALIZER;

  function ensureTopic(topic: string): TopicBuffer {
    let buf = topics.get(topic);
    if (!buf) {
      buf = { messages: [] };
      topics.set(topic, buf);
    }
    return buf;
  }

  return {
    /**
     * Produce a single event. Calls the consumer callback synchronously
     * (simulating Kafka's at-least-once delivery within the batch window).
     */
    produce(
      topic: string,
      event: string,
      payload: unknown,
      key: string | null,
    ): {
      message: KafkaMessage;
      serializationTimeMs: number;
      enqueueTimeMs: number;
    } {
      const t0 = performance.now();
      const envelope = createRawEventEnvelope(event as any, payload as any);
      const serialized = serializer.serialize(event, envelope);
      const serializationTimeMs = performance.now() - t0;

      const message: KafkaMessage = {
        key: key ?? crypto.randomUUID(),
        value: serialized,
        headers: {
          'slingshot.event': event,
          'slingshot.content-type': serializer.contentType,
        },
        timestamp: Date.now(),
      };

      const buf = ensureTopic(topic);
      const t1 = performance.now();
      buf.messages.push(message);
      const enqueueTimeMs = performance.now() - t1;

      return { message, serializationTimeMs, enqueueTimeMs };
    },

    /**
     * Consume all messages from a topic buffer, deserialize them, and
     * invoke the handler for each. Returns the messages as consumed.
     */
    consumeBatch(
      topic: string,
      handler: (event: string, payload: unknown, message: KafkaMessage) => void,
    ): { consumed: number; messages: KafkaMessage[]; durationMs: number } {
      const buf = topics.get(topic);
      if (!buf || buf.messages.length === 0) {
        return { consumed: 0, messages: [], durationMs: 0 };
      }

      const start = performance.now();
      const batch = buf.messages.splice(0, buf.messages.length);

      for (const msg of batch) {
        const envelope = serializer.deserialize(msg.headers['slingshot.event'], Buffer.from(msg.value));
        const payload = (envelope as { payload?: unknown })?.payload ?? envelope;
        handler(msg.headers['slingshot.event'], payload, msg);
      }

      return {
        consumed: batch.length,
        messages: batch,
        durationMs: performance.now() - start,
      };
    },

    /** Total messages across all topics. */
    totalMessages(): number {
      let total = 0;
      for (const buf of topics.values()) {
        total += buf.messages.length;
      }
      return total;
    },

    /** Clear all topic buffers. */
    reset(): void {
      topics.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmark 1: Produce throughput
// ---------------------------------------------------------------------------

async function benchProduceThroughput(): Promise<void> {
  const adapter = createFakeKafkaAdapter();
  const topic = 'bench.produce.test';
  const latencies = new Float64Array(PRODUCE_COUNT);

  // Warm-up
  for (let i = 0; i < 50; i++) {
    adapter.produce(topic, 'bench:produce', { seq: i, data: 'x'.repeat(256) }, `key-${i}`);
  }
  adapter.reset();

  const start = performance.now();
  for (let i = 0; i < PRODUCE_COUNT; i++) {
    const t0 = performance.now();
    adapter.produce(topic, 'bench:produce', { seq: i, data: 'x'.repeat(256) }, `key-${i}`);
    latencies[i] = performance.now() - t0;
  }
  const totalMs = performance.now() - start;

  latencies.sort();
  const throughput = (PRODUCE_COUNT / totalMs) * 1000;

  console.log(`[BENCH] kafka-produce-throughput`);
  console.log(`[BENCH]   mode: fake Kafka adapter`);
  console.log(`[BENCH]   events: ${PRODUCE_COUNT}`);
  console.log(`[BENCH]   total-duration-ms: ${formatDuration(totalMs)}`);
  console.log(`[BENCH]   throughput-events-per-sec: ${Math.round(throughput)}`);
  console.log(`[BENCH]   latency-p50-ms: ${formatDuration(computePercentiles(latencies, 50))}`);
  console.log(`[BENCH]   latency-p95-ms: ${formatDuration(computePercentiles(latencies, 95))}`);
  console.log(`[BENCH]   latency-p99-ms: ${formatDuration(computePercentiles(latencies, 99))}`);
  console.log(`[BENCH]   topic-buffer-size: ${adapter.totalMessages()}`);
}

// ---------------------------------------------------------------------------
// Benchmark 2: Consume throughput (batch)
// ---------------------------------------------------------------------------

async function benchConsumeThroughput(): Promise<void> {
  const adapter = createFakeKafkaAdapter();
  const topic = 'bench.consume.test';

  // Pre-populate messages
  for (let i = 0; i < PRODUCE_COUNT; i++) {
    adapter.produce(topic, 'bench:consume', { seq: i, data: 'y'.repeat(128) }, `key-${i}`);
  }

  let totalConsumed = 0;
  const batchDurations: number[] = [];
  let handlerCalls = 0;

  while (adapter.totalMessages() > 0) {
    const result = adapter.consumeBatch(topic, (_event, _payload, _msg) => {
      handlerCalls++;
    });
    totalConsumed += result.consumed;
    batchDurations.push(result.durationMs);
  }

  const totalMs = batchDurations.reduce((a, b) => a + b, 0);
  const throughput = (totalConsumed / totalMs) * 1000;

  batchDurations.sort((a, b) => a - b);

  console.log(`[BENCH] kafka-consume-throughput`);
  console.log(`[BENCH]   mode: fake Kafka adapter (batch size ${CONSUME_BATCH_SIZE})`);
  console.log(`[BENCH]   events: ${totalConsumed}`);
  console.log(`[BENCH]   handler-calls: ${handlerCalls}`);
  console.log(`[BENCH]   total-duration-ms: ${formatDuration(totalMs)}`);
  console.log(`[BENCH]   throughput-events-per-sec: ${Math.round(throughput)}`);
}

// ---------------------------------------------------------------------------
// Benchmark 3: End-to-end latency
// ---------------------------------------------------------------------------

async function benchEndToEndLatency(): Promise<void> {
  const adapter = createFakeKafkaAdapter();
  const topic = 'bench.e2e.test';
  const e2eCount = IS_FULL_BENCH ? 5_000 : 100;
  const e2eLatencies = new Float64Array(e2eCount);

  type TimedPayload = { seq: number; data: string; producedAt: number };

  // Produce all events with timestamps
  for (let i = 0; i < e2eCount; i++) {
    adapter.produce(
      topic,
      'bench:e2e',
      { seq: i, data: 'e2e-' + 'z'.repeat(64), producedAt: performance.now() },
      `e2e-${i}`,
    );
  }

  // Consume all and measure end-to-end latency
  const consumed = adapter.consumeBatch(topic, (_event, payload, _msg) => {
    const p = payload as TimedPayload;
    if (p.seq >= 0 && p.seq < e2eCount) {
      e2eLatencies[p.seq] = performance.now() - p.producedAt;
    }
  });

  const validLatencies = Float64Array.from(e2eLatencies).sort();
  const validCount = consumed.messages.length;

  console.log(`[BENCH] kafka-e2e-latency`);
  console.log(`[BENCH]   mode: fake Kafka adapter`);
  console.log(`[BENCH]   events: ${validCount}`);
  console.log(`[BENCH]   avg-latency-ms: ${formatDuration(validLatencies.reduce((a, b) => a + b, 0) / Math.max(1, validCount))}`);
  console.log(`[BENCH]   p50-latency-ms: ${formatDuration(computePercentiles(validLatencies, 50))}`);
  console.log(`[BENCH]   p95-latency-ms: ${formatDuration(computePercentiles(validLatencies, 95))}`);
  console.log(`[BENCH]   p99-latency-ms: ${formatDuration(computePercentiles(validLatencies, 99))}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`[BENCH] === slingshot-kafka produce/consume throughput ===`);
if (!IS_FULL_BENCH) {
  console.log(`[BENCH] Quick mode (set BENCH=1 for full benchmark)`);
}
console.log(``);

await benchProduceThroughput();
console.log(``);
await benchConsumeThroughput();
console.log(``);
await benchEndToEndLatency();

console.log(``);
console.log(`[BENCH] === done ===`);
process.exit(0);
