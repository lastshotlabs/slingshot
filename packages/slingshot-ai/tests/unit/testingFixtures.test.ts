import { describe, expect, test } from 'bun:test';
import { makeAiResult } from '../../src/testing';

describe('makeAiResult', () => {
  test('creates a deterministic complete result from a value', () => {
    expect(makeAiResult({ answer: 42 })).toEqual({
      value: { answer: 42 },
      stopReason: 'end',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        accounting: 'full',
      },
      moderation: null,
      degradations: [],
      provider: 'fixture',
      model: 'fixture-model',
      cached: 'none',
      latencyMs: 0,
      raw: null,
      toolCalls: [],
      iterations: 1,
    });
  });

  test('allows focused metadata overrides without rebuilding the result shape', () => {
    const result = makeAiResult('hello', {
      provider: 'test-provider',
      latencyMs: 12,
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        costUsd: null,
        accounting: 'none',
      },
    });

    expect(result.value).toBe('hello');
    expect(result.provider).toBe('test-provider');
    expect(result.latencyMs).toBe(12);
    expect(result.usage.inputTokens).toBe(3);
  });
});
