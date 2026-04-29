import { describe, expect, test } from 'bun:test';
import { HandlerResolutionError } from '../src/errors';

describe('HandlerResolutionError', () => {
  test('has correct name', () => {
    const err = new HandlerResolutionError('test message', {
      exportName: 'myHandler',
      handlerRef: './handlers',
    });
    expect(err.name).toBe('HandlerResolutionError');
  });

  test('is instance of Error', () => {
    const err = new HandlerResolutionError('msg', {
      exportName: 'x',
      handlerRef: 'y',
    });
    expect(err).toBeInstanceOf(Error);
  });

  test('exposes exportName and handlerRef', () => {
    const err = new HandlerResolutionError('msg', {
      exportName: 'processOrderApi',
      handlerRef: 'processOrder',
    });
    expect(err.exportName).toBe('processOrderApi');
    expect(err.handlerRef).toBe('processOrder');
  });

  test('handlersPath is optional', () => {
    const err = new HandlerResolutionError('msg', {
      exportName: 'x',
      handlerRef: 'y',
    });
    expect(err.handlersPath).toBeUndefined();
  });

  test('handlersPath is set when provided', () => {
    const err = new HandlerResolutionError('msg', {
      exportName: 'x',
      handlerRef: 'y',
      handlersPath: '/app/slingshot.handlers.ts',
    });
    expect(err.handlersPath).toBe('/app/slingshot.handlers.ts');
  });

  test('availableExports is optional', () => {
    const err = new HandlerResolutionError('msg', {
      exportName: 'x',
      handlerRef: 'y',
    });
    expect(err.availableExports).toBeUndefined();
  });

  test('availableExports is set when provided', () => {
    const err = new HandlerResolutionError('msg', {
      exportName: 'x',
      handlerRef: 'y',
      availableExports: ['fnA', 'fnB', 'fnC'],
    });
    expect(err.availableExports).toEqual(['fnA', 'fnB', 'fnC']);
  });

  test('message is verbose for operator diagnostics', () => {
    const err = new HandlerResolutionError('Handler not found', {
      exportName: 'missingHandler',
      handlerRef: './handlers.ts',
      handlersPath: '/app/build/handlers.js',
      availableExports: ['validHandler1', 'validHandler2'],
    });
    expect(err.message).toContain('Handler not found');
    expect(err.message.length).toBeGreaterThan(20);
  });

  test('cause is set when provided', () => {
    const cause = new Error('import failed');
    const err = new HandlerResolutionError('msg', {
      exportName: 'x',
      handlerRef: 'y',
      cause,
    });
    expect(err.cause).toBe(cause);
  });
});
