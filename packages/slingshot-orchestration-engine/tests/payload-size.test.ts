import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import { OrchestrationError } from '../src/errors';
import { createOrchestrationRuntime } from '../src/runtime';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  resolveMaxPayloadBytes,
  serializeWithLimit,
} from '../src/serialization';

describe('orchestration payload size limits', () => {
  test('serializeWithLimit rejects oversized payloads with PAYLOAD_TOO_LARGE', () => {
    const oversized = { blob: 'x'.repeat(2_048) };
    expect(() => serializeWithLimit(oversized, 1_024, "task 'big' input")).toThrow(
      OrchestrationError,
    );
    try {
      serializeWithLimit(oversized, 1_024, "task 'big' input");
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError);
      expect((error as OrchestrationError).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  test('serializeWithLimit accepts payloads at or below the limit', () => {
    const value = { ok: true };
    const serialized = serializeWithLimit(value, 1_024, 'test');
    expect(serialized).toBe('{"ok":true}');
  });

  test('resolveMaxPayloadBytes returns the default when undefined', () => {
    expect(resolveMaxPayloadBytes(undefined)).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
  });

  test('resolveMaxPayloadBytes rejects invalid sizes', () => {
    expect(() => resolveMaxPayloadBytes(0)).toThrow(/positive integer/);
    expect(() => resolveMaxPayloadBytes(-1)).toThrow(/positive integer/);
    expect(() => resolveMaxPayloadBytes(1.5)).toThrow(/positive integer/);
  });

  test('memory adapter rejects oversized task input with PAYLOAD_TOO_LARGE', async () => {
    const echo = defineTask({
      name: 'echo-task',
      input: z.object({ blob: z.string() }),
      output: z.object({ blob: z.string() }),
      async handler(input) {
        return { blob: input.blob };
      },
    });

    const adapter = createMemoryAdapter({ concurrency: 1, maxPayloadBytes: 1_024 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [echo] });

    const huge = 'x'.repeat(2_048);
    await expect(runtime.runTask(echo, { blob: huge })).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });

    await adapter.shutdown();
  });

  test('memory adapter marks run as failed when task output exceeds limit', async () => {
    const oversized = defineTask({
      name: 'oversized-output-task',
      input: z.object({}),
      output: z.object({ blob: z.string() }),
      async handler() {
        return { blob: 'y'.repeat(4_096) };
      },
    });

    const adapter = createMemoryAdapter({ concurrency: 1, maxPayloadBytes: 1_024 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [oversized] });

    const handle = await runtime.runTask(oversized, {});
    // The task handler completed in-process so handle.result() resolves with
    // the original value. The adapter still marks the durable run as failed so
    // that observers see the size violation.
    await handle.result().catch(() => {});

    const run = await runtime.getRun(handle.id);
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toMatch(/exceeds maximum payload size/);

    await adapter.shutdown();
  });
});
