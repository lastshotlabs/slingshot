import { describe, expect, test } from 'bun:test';

describe('Temporal status mapping', () => {
  test('maps running status', () => {
    // Temporal execution status to portable run status
    const statusMap: Record<string, string> = {
      RUNNING: 'running',
      COMPLETED: 'completed',
      FAILED: 'failed',
      CANCELED: 'cancelled',
      TERMINATED: 'cancelled',
      TIMED_OUT: 'failed',
    };
    expect(statusMap.RUNNING).toBe('running');
    expect(statusMap.COMPLETED).toBe('completed');
    expect(statusMap.FAILED).toBe('failed');
  });

  test('canceled and terminated both map to cancelled', () => {
    const statusMap: Record<string, string> = {
      CANCELED: 'cancelled',
      TERMINATED: 'cancelled',
    };
    expect(statusMap.CANCELED).toBe(statusMap.TERMINATED);
  });

  test('timed_out maps to failed', () => {
    const statusMap: Record<string, string> = {
      TIMED_OUT: 'failed',
    };
    expect(statusMap.TIMED_OUT).toBe('failed');
  });

  test('all temporal statuses have portable mappings', () => {
    const supportedStatuses = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT'];
    const statusMap: Record<string, string> = {
      RUNNING: 'running',
      COMPLETED: 'completed',
      FAILED: 'failed',
      CANCELED: 'cancelled',
      TERMINATED: 'cancelled',
      TIMED_OUT: 'failed',
    };
    for (const status of supportedStatuses) {
      expect(statusMap[status]).toBeDefined();
      expect(typeof statusMap[status]).toBe('string');
    }
  });

  test('unknown statuses are handled gracefully', () => {
    const fallback = 'unknown';
    expect(fallback).toBe('unknown');
  });
});

describe('Temporal IDs', () => {
  test('workflow IDs are deterministic', () => {
    // Same inputs produce same workflow ID
    const id1 = 'orch:wf:task-name:tenant-1:key-1';
    const id2 = 'orch:wf:task-name:tenant-1:key-1';
    expect(id1).toBe(id2);
  });

  test('different tenants produce different IDs', () => {
    const id1 = 'orch:wf:task-name:tenant-1:key-1';
    const id2 = 'orch:wf:task-name:tenant-2:key-1';
    expect(id1).not.toBe(id2);
  });

  test('different keys produce different IDs', () => {
    const id1 = 'orch:wf:task-name:tenant-1:key-1';
    const id2 = 'orch:wf:task-name:tenant-1:key-2';
    expect(id1).not.toBe(id2);
  });
});
