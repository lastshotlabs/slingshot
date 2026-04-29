import { describe, expect, test } from 'bun:test';
import type {
  CreateIntervalDispatcherOptions,
  DispatcherBreakerOptions,
  DispatcherRetryOptions,
} from '../src/dispatcher';

describe('Dispatcher type validation', () => {
  test('CreateIntervalDispatcherOptions accepts valid interval config', () => {
    const opts: CreateIntervalDispatcherOptions = {
      intervalMs: 5000,
      batchSize: 100,
    };
    expect(opts.intervalMs).toBe(5000);
    expect(opts.batchSize).toBe(100);
  });

  test('DispatcherBreakerOptions accepts valid breaker config', () => {
    const opts: DispatcherBreakerOptions = {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
    };
    expect(opts.failureThreshold).toBe(5);
    expect(opts.resetTimeoutMs).toBe(30000);
  });

  test('DispatcherRetryOptions accepts valid retry config', () => {
    const opts: DispatcherRetryOptions = {
      maxAttempts: 3,
      delayMs: 1000,
    };
    expect(opts.maxAttempts).toBe(3);
    expect(opts.delayMs).toBe(1000);
  });
});
