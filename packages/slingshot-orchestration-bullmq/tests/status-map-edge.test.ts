import { describe, expect, test } from 'bun:test';
import { mapBullMQStatus } from '../src/statusMap';

describe('mapBullMQStatus', () => {
  test('maps completed status', () => {
    const result = mapBullMQStatus('completed');
    expect(result).toBeDefined();
  });

  test('maps failed status', () => {
    const result = mapBullMQStatus('failed');
    expect(result).toBeDefined();
  });

  test('maps active to running and queued states to pending', () => {
    const active = mapBullMQStatus('active');
    const delayed = mapBullMQStatus('delayed');
    const waiting = mapBullMQStatus('waiting');
    expect(active).toBe('running');
    expect(delayed).toBe('pending');
    expect(waiting).toBe('pending');
  });

  test('unknown status has fallback', () => {
    const result = mapBullMQStatus('unknown-status' as any);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  test('completed status maps to completed', () => {
    const result = mapBullMQStatus('completed');
    expect(result).toBe('completed');
  });

  test('failed status maps to failed', () => {
    const result = mapBullMQStatus('failed');
    expect(result).toBe('failed');
  });
});
