import { describe, expect, test } from 'bun:test';
import { classifyOrchestrationError } from '../src/adapter';

describe('classifyOrchestrationError (P-OBULLMQ-6)', () => {
  test('marks ECONNREFUSED as transient/retryable', () => {
    const err = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    const classification = classifyOrchestrationError(err);
    expect(classification.retryable).toBe(true);
    expect(classification.permanent).toBe(false);
    expect(classification.code).toBe('ECONNREFUSED');
  });

  test('marks ECONNRESET as transient', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(classifyOrchestrationError(err).retryable).toBe(true);
  });

  test('marks EPIPE as transient', () => {
    const err = Object.assign(new Error('pipe'), { code: 'EPIPE' });
    expect(classifyOrchestrationError(err).retryable).toBe(true);
  });

  test('marks ETIMEDOUT as transient', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(classifyOrchestrationError(err).retryable).toBe(true);
  });

  test('marks redis cluster MOVED messages as transient', () => {
    const err = new Error('MOVED 1234 redis-2:6379');
    expect(classifyOrchestrationError(err).retryable).toBe(true);
  });

  test('marks redis LOADING messages as transient', () => {
    const err = new Error('LOADING Redis is loading the dataset');
    expect(classifyOrchestrationError(err).retryable).toBe(true);
  });

  test('marks ConnectionError as transient by error name', () => {
    const err = new Error('downstream connection lost');
    err.name = 'ConnectionError';
    expect(classifyOrchestrationError(err).retryable).toBe(true);
  });

  test('marks an arbitrary application error as permanent fail-fast', () => {
    const err = new TypeError('expected string, got number');
    const classification = classifyOrchestrationError(err);
    expect(classification.retryable).toBe(false);
    expect(classification.permanent).toBe(true);
  });

  test('marks a plain Error without a code as permanent', () => {
    const classification = classifyOrchestrationError(new Error('boom'));
    expect(classification.permanent).toBe(true);
  });

  test('marks null/undefined as permanent', () => {
    expect(classifyOrchestrationError(null).permanent).toBe(true);
    expect(classifyOrchestrationError(undefined).permanent).toBe(true);
  });
});
