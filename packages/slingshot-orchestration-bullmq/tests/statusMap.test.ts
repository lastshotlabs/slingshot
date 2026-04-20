import { describe, expect, test } from 'bun:test';
import { mapBullMQStatus } from '../src/statusMap';

describe('mapBullMQStatus', () => {
  test('maps active and terminal BullMQ states', () => {
    expect(mapBullMQStatus('active')).toBe('running');
    expect(mapBullMQStatus('completed')).toBe('completed');
    expect(mapBullMQStatus('failed')).toBe('failed');
  });

  test('maps queued and paused states to pending', () => {
    expect(mapBullMQStatus('waiting')).toBe('pending');
    expect(mapBullMQStatus('waiting-children')).toBe('pending');
    expect(mapBullMQStatus('paused')).toBe('pending');
  });
});
