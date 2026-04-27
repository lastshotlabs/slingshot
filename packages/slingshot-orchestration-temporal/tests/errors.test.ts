import {
  CancelledFailure,
  TerminatedFailure,
  TimeoutFailure,
  WorkflowFailedError,
} from '@temporalio/client';
import { describe, expect, test } from 'bun:test';
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';
import { mapTemporalFailure, toRunError, wrapTemporalError } from '../src/errors';

describe('mapTemporalFailure', () => {
  test('WorkflowFailedError surfaces the cause message', () => {
    const cause = new Error('activity timed out');
    const err = new WorkflowFailedError('workflow failed', cause, 'NON_RETRYABLE_FAILURE');
    const result = mapTemporalFailure('startRun', err);

    expect(result).toBeInstanceOf(OrchestrationError);
    expect(result.code).toBe('ADAPTER_ERROR');
    expect(result.message).toBe('startRun: workflow failed — activity timed out');
    expect(result.cause).toBe(err);
  });

  test('WorkflowFailedError with no cause falls back to "unknown cause"', () => {
    const err = new WorkflowFailedError('workflow failed', undefined, 'NON_RETRYABLE_FAILURE');
    const result = mapTemporalFailure('startRun', err);

    expect(result.message).toBe('startRun: workflow failed — unknown cause');
  });

  test('WorkflowFailedError with string cause uses that string', () => {
    const err = new WorkflowFailedError(
      'workflow failed',
      'string-cause' as unknown as Error,
      'NON_RETRYABLE_FAILURE',
    );
    const result = mapTemporalFailure('startRun', err);

    expect(result.message).toBe('startRun: workflow failed — string-cause');
  });

  test('CancelledFailure maps to "run was cancelled"', () => {
    const err = new CancelledFailure('workflow was cancelled');
    const result = mapTemporalFailure('cancelRun', err);

    expect(result).toBeInstanceOf(OrchestrationError);
    expect(result.code).toBe('ADAPTER_ERROR');
    expect(result.message).toBe('cancelRun: run was cancelled');
    expect(result.cause).toBe(err);
  });

  test('TerminatedFailure maps to "run was terminated"', () => {
    const err = new TerminatedFailure('workflow was terminated');
    const result = mapTemporalFailure('terminateRun', err);

    expect(result).toBeInstanceOf(OrchestrationError);
    expect(result.code).toBe('ADAPTER_ERROR');
    expect(result.message).toBe('terminateRun: run was terminated');
    expect(result.cause).toBe(err);
  });

  test('TimeoutFailure includes the timeout type in the message', () => {
    const err = new TimeoutFailure('timed out', undefined, 'START_TO_CLOSE');
    const result = mapTemporalFailure('waitRun', err);

    expect(result).toBeInstanceOf(OrchestrationError);
    expect(result.code).toBe('ADAPTER_ERROR');
    expect(result.message).toBe('waitRun: run timed out (START_TO_CLOSE)');
    expect(result.cause).toBe(err);
  });

  test('TimeoutFailure with SCHEDULE_TO_CLOSE type includes correct type', () => {
    const err = new TimeoutFailure('timed out', null, 'SCHEDULE_TO_CLOSE');
    const result = mapTemporalFailure('waitRun', err);

    expect(result.message).toBe('waitRun: run timed out (SCHEDULE_TO_CLOSE)');
  });

  test('unknown error falls through to wrapTemporalError', () => {
    const err = new Error('some other temporal error');
    const result = mapTemporalFailure('doSomething', err);

    expect(result).toBeInstanceOf(OrchestrationError);
    expect(result.code).toBe('ADAPTER_ERROR');
    expect(result.message).toBe('doSomething: some other temporal error');
    expect(result.cause).toBe(err);
  });

  test('non-Error value falls through and is stringified', () => {
    const result = mapTemporalFailure('doSomething', 'raw string error');

    expect(result).toBeInstanceOf(OrchestrationError);
    expect(result.message).toBe('doSomething: raw string error');
  });
});

describe('toRunError', () => {
  test('converts an Error to a RunError with message and stack', () => {
    const err = new Error('boom');
    const result = toRunError(err);

    expect(result.message).toBe('boom');
    expect(result.stack).toBeDefined();
  });

  test('converts a non-Error to a RunError with stringified message', () => {
    const result = toRunError('plain string');

    expect(result.message).toBe('plain string');
    expect(result.stack).toBeUndefined();
  });
});

describe('wrapTemporalError', () => {
  test('prefixes the error message', () => {
    const err = new Error('connection refused');
    const result = wrapTemporalError('connect', err);

    expect(result.code).toBe('ADAPTER_ERROR');
    expect(result.message).toBe('connect: connection refused');
    expect(result.cause).toBe(err);
  });

  test('stringifies non-Error values', () => {
    const result = wrapTemporalError('connect', 42);

    expect(result.message).toBe('connect: 42');
    expect(result.cause).toBeUndefined();
  });
});
