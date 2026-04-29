import { describe, expect, test } from 'bun:test';
import { HandlerResolutionError, TEST_LAMBDA_TIMEOUT_MS } from '../src/testing';

describe('runtime-lambda testing entrypoint', () => {
  test('exports test timeout and handler resolution error', () => {
    const err = new HandlerResolutionError('missing handler', {
      exportName: 'processOrderApi',
      handlerRef: 'processOrder',
      handlersPath: '/tmp/handlers.ts',
      availableExports: ['otherHandler'],
    });

    expect(TEST_LAMBDA_TIMEOUT_MS).toBe(10_000);
    expect(err.name).toBe('HandlerResolutionError');
    expect(err.availableExports).toEqual(['otherHandler']);
  });
});
