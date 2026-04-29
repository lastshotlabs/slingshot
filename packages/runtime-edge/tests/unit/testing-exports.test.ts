import { describe, expect, test } from 'bun:test';
import { TEST_EDGE_TIMEOUT_MS, TEST_MAX_FILE_BYTES } from '../../src/testing';

describe('runtime-edge testing entrypoint', () => {
  test('exports bounded test defaults', () => {
    expect(TEST_EDGE_TIMEOUT_MS).toBe(5_000);
    expect(TEST_MAX_FILE_BYTES).toBe(1024 * 1024);
  });
});
