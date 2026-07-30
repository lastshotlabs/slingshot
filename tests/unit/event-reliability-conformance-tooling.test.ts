import { describe, expect, test } from 'bun:test';
import {
  EVENT_RELIABILITY_CASES,
  type EventReliabilityConformanceReport,
  validateEventReliabilityConformanceReport,
} from '../../scripts/event-reliability-conformance';
import { renderEventReliabilitySupport } from '../../scripts/generate-event-reliability-support';

function validReport(): EventReliabilityConformanceReport {
  return {
    schemaVersion: 2,
    revision: 'abc123',
    results: EVENT_RELIABILITY_CASES.map(entry => ({
      ...entry,
      status: 'passed',
      durationMs: 1,
    })),
  };
}

describe('event reliability conformance tooling', () => {
  test('accepts complete passed evidence', () => {
    expect(validateEventReliabilityConformanceReport(validReport())).toEqual([]);
  });

  test('rejects missing receipt evidence and failed live combinations', () => {
    const report = validReport();
    const results = report.results.map(result =>
      result.id === 'dispatch.sqlite-kafka'
        ? { ...result, status: 'failed' as const, receiptEvidence: false }
        : result,
    );
    const errors = validateEventReliabilityConformanceReport({ ...report, results });
    expect(errors.some(error => error.includes('dispatch.sqlite-kafka did not pass'))).toBe(true);
    expect(errors.some(error => error.includes('without receipt evidence'))).toBe(true);
    expect(errors.some(error => error.includes('sqlite:kafka'))).toBe(true);
  });

  test('generated support matrix names every claimed live combination', () => {
    const output = renderEventReliabilitySupport();
    expect(output).toContain('| PostgreSQL | Supported, live repeated | Supported, live repeated');
    expect(output).toContain('| SQLite     | Supported, live repeated | Supported, live repeated');
  });
});
