import { describe, expect, test } from 'bun:test';
import { TEST_TEMPORAL_NAMESPACE, TEST_TEMPORAL_TIMEOUT_MS } from '../src/testing';

describe('orchestration Temporal testing entrypoint', () => {
  test('exports integration test defaults', () => {
    expect(TEST_TEMPORAL_TIMEOUT_MS).toBe(15_000);
    expect(TEST_TEMPORAL_NAMESPACE).toBe('slingshot-test');
  });
});
