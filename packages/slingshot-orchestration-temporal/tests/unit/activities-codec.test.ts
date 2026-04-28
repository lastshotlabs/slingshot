/**
 * Verifies that the internal `Client` constructed inside
 * `createTemporalActivities()` receives the same `dataConverter` and
 * `interceptors` that the worker was configured with.
 *
 * The activities-side `Client` is used to send signals from activities back
 * into the parent workflow (e.g. `slingshot-progress`). Without codec
 * symmetry, those signal payloads bypass the payload codec installed on the
 * server-side `Client` and the `Worker`, leaking unredacted PII to Temporal
 * Web UI and the visibility store.
 *
 * Lives under `tests/unit/` to keep the file isolatable from other tests in
 * the package — top-level `mock.module()` calls in this file would otherwise
 * leak into co-process tests in the same Bun invocation. The file is
 * therefore registered as its own suite in `scripts/workspace-test-suites.ts`
 * and excluded from the recursively-collected package suite.
 */
import { describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Capture every Client constructor call so we can assert the activities-side
// Client receives the codec and interceptors plumbed through worker options.
// ---------------------------------------------------------------------------

interface CapturedClientOptions {
  connection?: unknown;
  namespace?: string;
  dataConverter?: unknown;
  interceptors?: unknown;
}

const capturedClientOptions: CapturedClientOptions[] = [];

// Activities transitively imports `errors.ts` which pulls several named
// failure classes from `@temporalio/client`. Provide stubs for every named
// export the package source touches so the mocked module satisfies all
// transitive imports (otherwise Bun raises `Export named 'X' not found`).
mock.module('@temporalio/client', () => {
  class WorkflowFailedError extends Error {
    cause: unknown;
    constructor(message: string, cause?: unknown) {
      super(message);
      this.name = 'WorkflowFailedError';
      this.cause = cause;
    }
  }
  class CancelledFailure extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CancelledFailure';
    }
  }
  class TerminatedFailure extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TerminatedFailure';
    }
  }
  class TimeoutFailure extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TimeoutFailure';
    }
  }
  class ApplicationFailure extends Error {
    details: unknown[];
    constructor(message: string, _type?: string, ...details: unknown[]) {
      super(message);
      this.name = 'ApplicationFailure';
      this.details = details;
    }
  }
  class ScheduleNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ScheduleNotFoundError';
    }
  }

  return {
    Client: class FakeClient {
      workflow = {
        getHandle: () => ({
          async signal() {},
        }),
      };
      constructor(options: CapturedClientOptions) {
        capturedClientOptions.push(options);
      }
    },
    WorkflowFailedError,
    CancelledFailure,
    TerminatedFailure,
    TimeoutFailure,
    ApplicationFailure,
    ScheduleNotFoundError,
  };
});

mock.module('@temporalio/activity', () => ({
  Context: {
    current() {
      return {
        info: { attempt: 1, currentAttemptScheduledTimestampMs: Date.now() },
        cancellationSignal: undefined,
      };
    },
  },
}));

const { createTemporalActivities } = await import('../../src/activities');

describe('createTemporalActivities — codec/interceptor plumbing', () => {
  test('forwards dataConverter and interceptors into the internal Client', () => {
    capturedClientOptions.length = 0;

    const dataConverter = { payloadConverterPath: '/tmp/payload-converter.ts' };
    const interceptors = {
      workflow: [{ create: () => ({}) }],
    };
    const connection = { fake: true } as never;

    createTemporalActivities({
      connection,
      namespace: 'tenant-a',
      dataConverter: dataConverter as never,
      interceptors: interceptors as never,
    });

    expect(capturedClientOptions).toHaveLength(1);
    const opts = capturedClientOptions[0]!;
    expect(opts.connection).toBe(connection);
    expect(opts.namespace).toBe('tenant-a');
    expect(opts.dataConverter).toBe(dataConverter);
    expect(opts.interceptors).toBe(interceptors);
  });

  test('omits dataConverter and interceptors when the caller does not provide them', () => {
    capturedClientOptions.length = 0;

    createTemporalActivities({
      connection: { fake: true } as never,
    });

    expect(capturedClientOptions).toHaveLength(1);
    const opts = capturedClientOptions[0]!;
    expect(opts.dataConverter).toBeUndefined();
    expect(opts.interceptors).toBeUndefined();
    // Namespace is also optional and must not appear when unset, so
    // `Client` falls back to its `'default'` default.
    expect(opts.namespace).toBeUndefined();
  });

  test('forwards only dataConverter when interceptors are unset', () => {
    capturedClientOptions.length = 0;

    const dataConverter = { payloadConverterPath: '/tmp/pc.ts' };

    createTemporalActivities({
      connection: { fake: true } as never,
      dataConverter: dataConverter as never,
    });

    expect(capturedClientOptions).toHaveLength(1);
    const opts = capturedClientOptions[0]!;
    expect(opts.dataConverter).toBe(dataConverter);
    expect(opts.interceptors).toBeUndefined();
  });

  test('forwards only interceptors when dataConverter is unset', () => {
    capturedClientOptions.length = 0;

    const interceptors = { workflow: [{ create: () => ({}) }] };

    createTemporalActivities({
      connection: { fake: true } as never,
      interceptors: interceptors as never,
    });

    expect(capturedClientOptions).toHaveLength(1);
    const opts = capturedClientOptions[0]!;
    expect(opts.interceptors).toBe(interceptors);
    expect(opts.dataConverter).toBeUndefined();
  });
});
