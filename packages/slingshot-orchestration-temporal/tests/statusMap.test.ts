import { describe, expect, test } from 'bun:test';
import { mapTemporalStatus } from '../src/statusMap';

describe('mapTemporalStatus', () => {
  test('maps closed and running Temporal statuses to portable statuses', () => {
    expect(mapTemporalStatus('RUNNING')).toBe('running');
    expect(mapTemporalStatus('COMPLETED')).toBe('completed');
    expect(mapTemporalStatus('FAILED')).toBe('failed');
    expect(mapTemporalStatus('TIMED_OUT')).toBe('failed');
    expect(mapTemporalStatus('TERMINATED')).toBe('failed');
    expect(mapTemporalStatus('CANCELLED')).toBe('cancelled');
    expect(mapTemporalStatus('PAUSED')).toBe('pending');
    expect(mapTemporalStatus('CONTINUED_AS_NEW')).toBe('pending');
    expect(mapTemporalStatus('UNKNOWN')).toBe('pending');
    expect(mapTemporalStatus('UNSPECIFIED')).toBe('pending');
    expect(mapTemporalStatus(undefined)).toBe('pending');
    expect(mapTemporalStatus('UNRECOGNIZED')).toBe('pending');
  });

  test('RUNNING always maps to running', () => {
    // The most common live-state mapping should be stable
    expect(mapTemporalStatus('RUNNING')).toBe('running');
  });

  test('COMPLETED always maps to completed', () => {
    expect(mapTemporalStatus('COMPLETED')).toBe('completed');
  });

  test('FAILED, TIMED_OUT, TERMINATED all map to failed', () => {
    expect(mapTemporalStatus('FAILED')).toBe('failed');
    expect(mapTemporalStatus('TIMED_OUT')).toBe('failed');
    expect(mapTemporalStatus('TERMINATED')).toBe('failed');
  });

  test('TIMED_OUT is distinct from FAILED in Temporal but maps to same portable status', () => {
    // Temporal differentiates between FAILED and TIMED_OUT but Slingshot
    // collapses both to 'failed' since neither can progress without intervention.
    const timedOut = mapTemporalStatus('TIMED_OUT');
    const failed = mapTemporalStatus('FAILED');
    expect(timedOut).toBe(failed);
    expect(timedOut).toBe('failed');
  });

  test('CANCELLED maps to cancelled', () => {
    expect(mapTemporalStatus('CANCELLED')).toBe('cancelled');
  });

  test('CANCELED (single L, US spelling) maps to cancelled', () => {
    // Temporal uses 'CANCELED' (American English) in its API
    expect(mapTemporalStatus('CANCELED')).toBe('cancelled');
  });

  test('TERMINATED maps to failed (not cancelled)', () => {
    // In Temporal, TERMINATED means the workflow was forcefully killed
    // (e.g. via the CLI or UI), not a clean cancellation. Slingshot maps
    // it to 'failed' to distinguish from graceful cancellation.
    expect(mapTemporalStatus('TERMINATED')).toBe('failed');
  });

  test('all known Temporal statuses have a defined mapping', () => {
    // Known execution statuses from @temporalio/common
    const allKnown = [
      'UNSPECIFIED',
      'RUNNING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'CANCELED',
      'TERMINATED',
      'TIMED_OUT',
      'PAUSED',
      'CONTINUED_AS_NEW',
      'UNKNOWN',
    ];

    // All statuses must map to one of the four portable states
    const validPortableStatuses = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);

    for (const status of allKnown) {
      const mapped = mapTemporalStatus(status);
      expect(validPortableStatuses.has(mapped),
        `Temporal status '${status}' mapped to '${mapped}' which is not a valid portable status`,
      ).toBe(true);
    }
  });

  test('empty string maps to pending', () => {
    expect(mapTemporalStatus('')).toBe('pending');
  });

  test('nullish input maps to pending', () => {
    expect(mapTemporalStatus(null as unknown as string)).toBe('pending');
  });

  test('arbitrary unrecognized strings map to pending', () => {
    expect(mapTemporalStatus('NON_EXISTENT_STATUS_12345')).toBe('pending');
    expect(mapTemporalStatus('  ')).toBe('pending');
    expect(mapTemporalStatus('random-string')).toBe('pending');
  });

  test('lowercase temporal status is not recognized', () => {
    // Temporal statuses are uppercase enum values - lowercase is unrecognized
    expect(mapTemporalStatus('running')).toBe('pending');
    expect(mapTemporalStatus('completed')).toBe('pending');
  });

  test('maps RETURNED status if it appears (unlisted but defensive)', () => {
    // Defensive: if Temporal adds new statuses, they map to pending
    const result = mapTemporalStatus('RETURNED');
    expect(result).toBe('pending');
  });

  test('maps all non-terminal statuses correctly', () => {
    // Non-terminal: workflow is still running or in a transient state
    expect(mapTemporalStatus('RUNNING')).toBe('running');
    expect(mapTemporalStatus('PAUSED')).toBe('pending');
    expect(mapTemporalStatus('CONTINUED_AS_NEW')).toBe('pending');
    expect(mapTemporalStatus('UNKNOWN')).toBe('pending');
  });

  test('maps all terminal statuses correctly', () => {
    // Terminal: workflow has finished execution
    expect(mapTemporalStatus('COMPLETED')).toBe('completed');
    expect(mapTemporalStatus('FAILED')).toBe('failed');
    expect(mapTemporalStatus('TIMED_OUT')).toBe('failed');
    expect(mapTemporalStatus('TERMINATED')).toBe('failed');
    expect(mapTemporalStatus('CANCELLED')).toBe('cancelled');
    expect(mapTemporalStatus('CANCELED')).toBe('cancelled');
  });
});
