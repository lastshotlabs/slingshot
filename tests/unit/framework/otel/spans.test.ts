import { trace } from '@opentelemetry/api';
import { describe, expect, test } from 'bun:test';
import { withSpan, withSpanSync } from '../../../../src/framework/otel/spans';

const tracer = trace.getTracer('test');

describe('withSpan', () => {
  test('calls the function and returns its result', async () => {
    const result = await withSpan(tracer, 'test-span', async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test('passes span to the function', async () => {
    let receivedSpan = false;
    await withSpan(tracer, 'test-span', async span => {
      receivedSpan = span !== undefined && typeof span.setAttribute === 'function';
    });
    expect(receivedSpan).toBe(true);
  });

  test('re-throws errors from the function', async () => {
    const error = new Error('test error');
    await expect(
      withSpan(tracer, 'test-span', async () => {
        throw error;
      }),
    ).rejects.toThrow('test error');
  });

  test('re-throws non-Error values as errors', async () => {
    await expect(
      withSpan(tracer, 'test-span', async () => {
        throw 'string error';
      }),
    ).rejects.toThrow('string error');
  });
});

describe('withSpanSync', () => {
  test('calls the function and returns its result', () => {
    const result = withSpanSync(tracer, 'test-span', () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test('passes span to the function', () => {
    let receivedSpan = false;
    withSpanSync(tracer, 'test-span', span => {
      receivedSpan = span !== undefined && typeof span.setAttribute === 'function';
    });
    expect(receivedSpan).toBe(true);
  });

  test('re-throws errors from the function', () => {
    const error = new Error('sync test error');
    expect(() =>
      withSpanSync(tracer, 'test-span', () => {
        throw error;
      }),
    ).toThrow('sync test error');
  });

  test('re-throws non-Error values as errors', () => {
    expect(() =>
      withSpanSync(tracer, 'test-span', () => {
        throw 'string error';
      }),
    ).toThrow('string error');
  });
});
