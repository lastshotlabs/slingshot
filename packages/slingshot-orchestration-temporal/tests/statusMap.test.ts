import { describe, expect, test } from 'bun:test';
import { mapTemporalStatus } from '../src/statusMap';

describe('mapTemporalStatus', () => {
  test('maps closed and running Temporal statuses to portable statuses', () => {
    expect(mapTemporalStatus('RUNNING')).toBe('running');
    expect(mapTemporalStatus('COMPLETED')).toBe('completed');
    expect(mapTemporalStatus('FAILED')).toBe('failed');
    expect(mapTemporalStatus('TIMED_OUT')).toBe('failed');
    expect(mapTemporalStatus('CANCELLED')).toBe('cancelled');
  });
});
