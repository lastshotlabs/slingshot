import { describe, expect, test } from 'bun:test';
import { HandlerResolutionError } from '../src/errors';

describe('HandlerResolutionError', () => {
  test('captures manifest resolution details and cause', () => {
    const cause = new Error('import failed');
    const err = new HandlerResolutionError('Cannot resolve handler', {
      exportName: 'processOrderApi',
      handlerRef: 'processOrder',
      handlersPath: '/var/task/handlers.ts',
      availableExports: ['healthCheck'],
      cause,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HandlerResolutionError');
    expect(err.message).toBe('Cannot resolve handler');
    expect(err.exportName).toBe('processOrderApi');
    expect(err.handlerRef).toBe('processOrder');
    expect(err.handlersPath).toBe('/var/task/handlers.ts');
    expect(err.availableExports).toEqual(['healthCheck']);
    expect(err.cause).toBe(cause);
  });

  test('omits optional fields when they are not available', () => {
    const err = new HandlerResolutionError('Missing handler', {
      exportName: 'scheduledJob',
      handlerRef: 'nightly',
    });

    expect(err.handlersPath).toBeUndefined();
    expect(err.availableExports).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});
