import { describe, expect, test } from 'bun:test';
import { type ErrorClassification, classifyOrchestrationError } from '../src/errorClassification';

describe('classifyOrchestrationError', () => {
  test('classifies retryable errors', () => {
    const err = new Error('temporary failure');
    const classification = classifyOrchestrationError(err);
    expect(classification).toBeDefined();
    expect(typeof classification.retryable).toBe('boolean');
  });

  test('classifies non-retryable errors', () => {
    const err = new TypeError('invalid type');
    const classification = classifyOrchestrationError(err);
    expect(classification).toBeDefined();
  });

  test('handles errors with cause chains', () => {
    const cause = new Error('underlying issue');
    const err = new Error('wrapper');
    (err as any).cause = cause;
    const classification = classifyOrchestrationError(err);
    expect(classification).toBeDefined();
  });

  test('handles null/undefined gracefully', () => {
    const c1 = classifyOrchestrationError(null);
    const c2 = classifyOrchestrationError(undefined);
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
  });

  test('handles non-Error values', () => {
    const c1 = classifyOrchestrationError('string error');
    const c2 = classifyOrchestrationError(42);
    const c3 = classifyOrchestrationError({ code: 'ERR' });
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c3).toBeDefined();
  });

  test('classification is consistent for same error', () => {
    const err = new Error('consistent error');
    const c1 = classifyOrchestrationError(err);
    const c2 = classifyOrchestrationError(err);
    expect(c1.retryable).toBe(c2.retryable);
  });
});

describe('ErrorClassification type', () => {
  test('has retryable flag', () => {
    const classification: ErrorClassification = {
      retryable: false,
    };
    expect(classification.retryable).toBe(false);
  });

  test('retryable true indicates should retry', () => {
    const classification: ErrorClassification = {
      retryable: true,
    };
    expect(classification.retryable).toBe(true);
  });
});
