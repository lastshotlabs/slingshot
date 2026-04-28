/**
 * Shared test factories for `@lastshotlabs/slingshot-mail`.
 *
 * Mirrors the `./testing` sub-export used by `slingshot-notifications` and
 * `slingshot-push`. Surfaces only what mail tests already build informally —
 * a recording stub provider, a default-message factory, and a small wrapper
 * around the in-process memory queue that suppresses its non-durable warning.
 *
 * Nothing here is appropriate for production paths.
 */
import { createMemoryQueue } from './queues/memory';
import type { MailMessage, MailProvider, SendResult } from './types/provider';
import { MailSendError } from './types/provider';
import type { MailQueue, MailQueueConfig } from './types/queue';

/**
 * A stub `MailProvider` that records every send call and lets tests inject
 * outcomes (success, rejection, retryable failure, permanent failure).
 *
 * The `sends` array exposes every message handed to `send()` in call order so
 * tests can assert on subjects, recipients, and tags without re-stubbing
 * `mock(...)` per test.
 */
export interface StubMailProvider extends MailProvider {
  /** Every message passed to `send()`, in call order. */
  readonly sends: MailMessage[];
  /** Number of `send()` invocations (including failed ones). */
  readonly callCount: () => number;
  /** Replace the response for the next call only. Falls back to default after. */
  enqueueResponse(result: SendResult | MailSendError | Error): void;
  /** Replace the default response used when no `enqueueResponse` is queued. */
  setDefaultResponse(result: SendResult | MailSendError | Error): void;
  /** Forget all queued responses and recorded sends. */
  reset(): void;
}

const DEFAULT_RESULT: SendResult = { status: 'sent', messageId: 'stub-msg', raw: null };

/**
 * Create a recording stub provider for use in tests.
 *
 * @param options - Optional name (default `'stub'`) and starting default response.
 */
export function createStubMailProvider(options?: {
  name?: string;
  defaultResponse?: SendResult | MailSendError | Error;
}): StubMailProvider {
  const sends: MailMessage[] = [];
  const queued: Array<SendResult | MailSendError | Error> = [];
  let defaultResponse: SendResult | MailSendError | Error =
    options?.defaultResponse ?? DEFAULT_RESULT;

  function nextResponse(): SendResult | MailSendError | Error {
    return queued.length > 0
      ? (queued.shift() as SendResult | MailSendError | Error)
      : defaultResponse;
  }

  return {
    name: options?.name ?? 'stub',
    sends,
    callCount: () => sends.length,
    enqueueResponse(result) {
      queued.push(result);
    },
    setDefaultResponse(result) {
      defaultResponse = result;
    },
    reset() {
      sends.length = 0;
      queued.length = 0;
      defaultResponse = options?.defaultResponse ?? DEFAULT_RESULT;
    },
    async send(message) {
      sends.push(message);
      const response = nextResponse();
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  };
}

/**
 * Create a `MailMessage` with sensible test defaults; merge in any overrides.
 *
 * Useful when a test just needs "any valid message" and only cares about a
 * specific field (e.g. asserting `subject` was passed through).
 */
export function createTestMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: 'recipient@example.com',
    subject: 'Test',
    html: '<p>Test</p>',
    ...overrides,
  };
}

/**
 * Create an in-process memory queue with the non-durable warning silenced.
 *
 * Returns the same `MailQueue` instance as `createMemoryQueue` but suppresses
 * the noisy `console.warn` that fires on construction so tests don't have to
 * spy and restore manually. The original warning is preserved for production
 * paths.
 */
export function createTestMemoryQueue(config?: MailQueueConfig): MailQueue {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return createMemoryQueue(config);
  } finally {
    console.warn = originalWarn;
  }
}
