import { describe, expect, test } from 'bun:test';

describe('BullMQ orchestration — serialization', () => {
  test('JSON roundtrips objects', () => {
    const data = { task: 'test', input: { value: 42 } };
    const serialized = JSON.stringify(data);
    const deserialized = JSON.parse(serialized);
    expect(deserialized).toEqual(data);
  });

  test('handles Date serialization', () => {
    const data = { timestamp: new Date().toISOString() };
    const serialized = JSON.stringify(data);
    const deserialized = JSON.parse(serialized);
    expect(typeof deserialized.timestamp).toBe('string');
  });

  test('handles null and undefined', () => {
    const data = { a: null, b: undefined };
    const serialized = JSON.stringify(data);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.a).toBeNull();
    expect('b' in deserialized).toBe(false);
  });

  test('handles empty objects', () => {
    const data = {};
    const serialized = JSON.stringify(data);
    expect(serialized).toBe('{}');
    expect(JSON.parse(serialized)).toEqual({});
  });

  test('handles arrays', () => {
    const data = [1, 2, { nested: true }];
    const serialized = JSON.stringify(data);
    expect(JSON.parse(serialized)).toEqual(data);
  });

  test('rejects circular references', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    expect(() => JSON.stringify(obj)).toThrow();
  });

  test('payload size is measured in bytes', () => {
    const data = { key: 'value' };
    const serialized = JSON.stringify(data);
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    expect(byteLength).toBeGreaterThan(0);
  });
});
