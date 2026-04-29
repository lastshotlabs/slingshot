// packages/slingshot-orchestration/tests/serialization-edge.test.ts
//
// Edge-case tests for serialization helpers: undefined/non-JSON-serializable
// inputs, circular references, boundary values for resolveMaxPayloadBytes,
// and assertPayloadSize behavior.
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  PAYLOAD_BYTES_CEILING,
  assertPayloadSize,
  resolveMaxPayloadBytes,
  serializeWithLimit,
} from '../src/serialization';
import { OrchestrationError } from '../src/errors';

describe('serializeWithLimit — undefined and non-JSON inputs', () => {
  test('returns empty string for undefined', () => {
    expect(serializeWithLimit(undefined, 1024, 'test')).toBe('');
  });

  test('returns empty string for function (JSON-silent value)', () => {
    expect(serializeWithLimit(() => {}, 1024, 'test')).toBe('');
  });

  test('returns empty string for Symbol', () => {
    expect(serializeWithLimit(Symbol('x'), 1024, 'test')).toBe('');
  });

  test('serializes null as the string "null"', () => {
    expect(serializeWithLimit(null, 1024, 'test')).toBe('null');
  });

  test('serializes number zero correctly', () => {
    expect(serializeWithLimit(0, 1024, 'test')).toBe('0');
  });

  test('serializes empty object', () => {
    expect(serializeWithLimit({}, 1024, 'test')).toBe('{}');
  });
});

describe('serializeWithLimit — error cases', () => {
  test('throws INVALID_CONFIG for non-JSON-serializable values (BigInt)', () => {
    // BigInt is not JSON-serializable and will cause JSON.stringify to throw
    expect(() =>
      serializeWithLimit({ value: BigInt(123) }, 1024, 'test-bigint'),
    ).toThrow(OrchestrationError);
  });

  test('throws INVALID_CONFIG with details for circular references', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => serializeWithLimit(circular, 1024, 'circular')).toThrow(
      OrchestrationError,
    );
  });

  test('error includes the JSON serialization failure message', () => {
    const circular: Record<string, unknown> = { x: 1 };
    circular.self = circular;
    try {
      serializeWithLimit(circular, 1024, 'my-label');
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe('INVALID_CONFIG');
      expect((err as OrchestrationError).message).toContain('my-label');
    }
  });
});

describe('serializeWithLimit — byte boundary accuracy', () => {
  test('multi-byte UTF-8 characters are counted correctly', () => {
    // The rocket emoji is 4 bytes in UTF-8
    const value = { msg: '\u{1F680}' };
    // '{"msg":"🚀"}' = 14 bytes (ASCII chars) + 4 bytes (emoji) = 18 bytes
    const serialized = serializeWithLimit(value, 18, 'emoji');
    expect(serialized).toBe('{"msg":"\u{1F680}"}');
  });

  test('multi-byte UTF-8 at exactly the byte limit passes', () => {
    // 3 emojis = 12 bytes in the value portion
    const value = { m: '\u{1F680}\u{1F680}\u{1F680}' };
    // Serialized: {"m":"🚀🚀🚀"}
    // 6 ASCII + 12 emoji + 2 ASCII = 20 bytes total
    const serialized = serializeWithLimit(value, 20, 'emoji-triple');
    expect(serialized).toBe('{"m":"\u{1F680}\u{1F680}\u{1F680}"}');
  });

  test('multi-byte UTF-8 one byte over the limit fails', () => {
    const value = { m: '\u{1F680}\u{1F680}\u{1F680}' };
    // 19 bytes is insufficient for a 20-byte payload
    expect(() => serializeWithLimit(value, 19, 'too-small')).toThrow(
      OrchestrationError,
    );
  });
});

describe('resolveMaxPayloadBytes — boundary values', () => {
  test('returns default when undefined', () => {
    expect(resolveMaxPayloadBytes(undefined)).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
  });

  test('accepts exact ceiling value', () => {
    expect(resolveMaxPayloadBytes(PAYLOAD_BYTES_CEILING)).toBe(PAYLOAD_BYTES_CEILING);
  });

  test('rejects value above ceiling', () => {
    expect(() => resolveMaxPayloadBytes(PAYLOAD_BYTES_CEILING + 1)).toThrow(
      OrchestrationError,
    );
  });

  test('rejects zero', () => {
    expect(() => resolveMaxPayloadBytes(0)).toThrow(OrchestrationError);
  });

  test('rejects negative value', () => {
    expect(() => resolveMaxPayloadBytes(-1)).toThrow(OrchestrationError);
  });

  test('rejects float', () => {
    expect(() => resolveMaxPayloadBytes(1.5)).toThrow(OrchestrationError);
  });

  test('rejects NaN', () => {
    expect(() => resolveMaxPayloadBytes(NaN)).toThrow(OrchestrationError);
  });

  test('rejects Infinity', () => {
    expect(() => resolveMaxPayloadBytes(Infinity)).toThrow(OrchestrationError);
  });

  test('accepts minimum valid value', () => {
    expect(resolveMaxPayloadBytes(1)).toBe(1);
  });

  test('accepts a valid custom value', () => {
    expect(resolveMaxPayloadBytes(4096)).toBe(4096);
  });

  test('uses custom label in error messages', () => {
    try {
      resolveMaxPayloadBytes(-5, 'custom-label');
    } catch (err) {
      expect((err as OrchestrationError).message).toContain('custom-label');
    }
  });
});

describe('assertPayloadSize', () => {
  test('does not throw for values under the limit', () => {
    expect(() => assertPayloadSize({ ok: true }, 1024, 'test')).not.toThrow();
  });

  test('throws PAYLOAD_TOO_LARGE for values over the limit', () => {
    expect(() => assertPayloadSize({ data: 'x'.repeat(2048) }, 1024, 'oversized')).toThrow(
      OrchestrationError,
    );
  });

  test('does not throw for undefined input', () => {
    expect(() => assertPayloadSize(undefined, 1024, 'empty')).not.toThrow();
  });
});
