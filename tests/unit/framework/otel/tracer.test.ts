import { describe, expect, test } from 'bun:test';
import { getTracer, isTracingEnabled } from '../../../../src/framework/otel/tracer';

describe('getTracer', () => {
  test('returns a Tracer object (no-op when no SDK registered)', () => {
    const tracer = getTracer(undefined);
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');
    expect(typeof tracer.startActiveSpan).toBe('function');
  });

  test('returns a Tracer when config is provided', () => {
    const tracer = getTracer({ enabled: true, serviceName: 'test-app' });
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');
  });

  test('returns a Tracer when config has no serviceName', () => {
    const tracer = getTracer({ enabled: true });
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');
  });
});

describe('isTracingEnabled', () => {
  test('returns false for undefined', () => {
    expect(isTracingEnabled(undefined)).toBe(false);
  });

  test('returns false for { enabled: false }', () => {
    expect(isTracingEnabled({ enabled: false })).toBe(false);
  });

  test('returns false for empty object', () => {
    expect(isTracingEnabled({})).toBe(false);
  });

  test('returns true for { enabled: true }', () => {
    expect(isTracingEnabled({ enabled: true })).toBe(true);
  });
});
