import { describe, expect, test } from 'bun:test';
import {
  saslSchema,
  sslSchema,
  compressionSchema,
  COMPRESSION_CODEC,
  backoffMs,
} from '../src/kafkaShared';

describe('saslSchema', () => {
  test('validates plain mechanism', () => {
    const result = saslSchema.safeParse({ mechanism: 'plain', username: 'u', password: 'p' });
    expect(result.success).toBe(true);
  });

  test('validates scram-sha-256 mechanism', () => {
    const result = saslSchema.safeParse({ mechanism: 'scram-sha-256', username: 'u', password: 'p' });
    expect(result.success).toBe(true);
  });

  test('validates scram-sha-512 mechanism', () => {
    const result = saslSchema.safeParse({ mechanism: 'scram-sha-512', username: 'u', password: 'p' });
    expect(result.success).toBe(true);
  });

  test('rejects unknown mechanism', () => {
    const result = saslSchema.safeParse({ mechanism: 'unknown', username: 'u', password: 'p' });
    expect(result.success).toBe(false);
  });

  test('rejects missing username', () => {
    const result = saslSchema.safeParse({ mechanism: 'plain', password: 'p' });
    expect(result.success).toBe(false);
  });

  test('rejects missing password', () => {
    const result = saslSchema.safeParse({ mechanism: 'plain', username: 'u' });
    expect(result.success).toBe(false);
  });

  test('rejects empty object', () => {
    const result = saslSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('sslSchema', () => {
  test('accepts boolean true', () => {
    const result = sslSchema.safeParse(true);
    expect(result.success).toBe(true);
  });

  test('accepts object with ca', () => {
    const result = sslSchema.safeParse({ ca: 'cert-data' });
    expect(result.success).toBe(true);
  });

  test('accepts full object', () => {
    const result = sslSchema.safeParse({ ca: 'ca', cert: 'cert', key: 'key', rejectUnauthorized: false });
    expect(result.success).toBe(true);
  });

  test('rejects string', () => {
    const result = sslSchema.safeParse('ssl');
    expect(result.success).toBe(false);
  });

  test('rejects number', () => {
    const result = sslSchema.safeParse(42);
    expect(result.success).toBe(false);
  });
});

describe('compressionSchema', () => {
  test.each(['gzip', 'snappy', 'lz4', 'zstd'] as const)('accepts %s', (codec) => {
    const result = compressionSchema.safeParse(codec);
    expect(result.success).toBe(true);
  });

  test('rejects unknown codec', () => {
    const result = compressionSchema.safeParse('brotli');
    expect(result.success).toBe(false);
  });

  test('rejects empty string', () => {
    const result = compressionSchema.safeParse('');
    expect(result.success).toBe(false);
  });
});

describe('COMPRESSION_CODEC', () => {
  test('maps all compression types to Kafka CompressionTypes', () => {
    expect(COMPRESSION_CODEC.gzip).toBeDefined();
    expect(COMPRESSION_CODEC.snappy).toBeDefined();
    expect(COMPRESSION_CODEC.lz4).toBeDefined();
    expect(COMPRESSION_CODEC.zstd).toBeDefined();
  });
});

describe('backoffMs', () => {
  test('returns a positive number', () => {
    expect(backoffMs(1)).toBeGreaterThan(0);
  });

  test('grows with attempt count', () => {
    const b1 = backoffMs(1);
    const b4 = backoffMs(4);
    expect(b4).toBeGreaterThan(b1);
  });

  test('caps at 30 seconds base', () => {
    // With base capped at 30_000 and jitter up to 100, max is 30_100
    const result = backoffMs(20);
    expect(result).toBeLessThanOrEqual(30_100);
  });

  test('handles attempt=0 gracefully', () => {
    // Math.max(0, -1) = 0, so base = 250 * 2^0 = 250
    expect(backoffMs(0)).toBeGreaterThanOrEqual(250);
    expect(backoffMs(0)).toBeLessThanOrEqual(350); // 250 + jitter < 100
  });

  test('produces varying results due to jitter', () => {
    const results = new Set(Array.from({ length: 20 }, () => backoffMs(1)));
    // With 100ms jitter range, 20 samples should produce >1 unique value
    expect(results.size).toBeGreaterThan(1);
  });
});
