import type { SlingshotContext } from './context/slingshotContext';
import type { HandlerMeta, SlingshotHandler } from './handler';
import type { SlingshotRuntime } from './runtime';

/**
 * One normalized record extracted from a trigger event.
 */
export interface TriggerRecord {
  body: unknown;
  meta: Record<string, unknown>;
  naturalKey?: string;
}

/**
 * Per-record processing outcome.
 */
export interface RecordOutcome {
  meta: Record<string, unknown>;
  result: 'success' | 'error';
  output?: unknown;
  error?: Error;
}

/**
 * Metadata extracted from a trigger event by a {@link TriggerAdapter}.
 *
 * Extends `Partial<HandlerMeta>` with raw identity fields that the Lambda
 * runtime hands to the configured `IdentityResolver` to construct the
 * canonical {@link Actor}. Trigger adapters can either set the `actor` field
 * directly or supply the raw identity fields and let `buildMeta` derive the
 * actor through the resolver.
 *
 * Field names mirror {@link IdentityResolverInput}.
 */
export interface TriggerExtractedMeta extends Partial<HandlerMeta> {
  /** Tenant context from the trigger event metadata. */
  tenantId?: string | null;
  /** Authenticated user ID from the trigger event metadata. */
  userId?: string | null;
  /** Service-account / M2M client ID from the trigger event metadata. */
  serviceAccountId?: string | null;
  /** Static API-key client ID from the trigger event metadata. */
  apiKeyId?: string | null;
  /** Effective roles from the trigger event metadata. */
  roles?: string[] | null;
}

/**
 * Cloud-agnostic trigger adapter.
 */
export interface TriggerAdapter<TEvent = unknown, TResult = unknown> {
  readonly kind: string;
  extractInputs(event: TEvent): TriggerRecord[];
  extractMeta(event: TEvent, record: TriggerRecord): TriggerExtractedMeta;
  assembleResult(outcomes: RecordOutcome[]): TResult;
}

/**
 * Lifecycle hooks for a functions runtime.
 */
export interface FunctionsHooks {
  onInit?(ctx: SlingshotContext): void | Promise<void>;
  beforeInvoke?(args: BeforeInvokeArgs): InvokeAbort | undefined | Promise<InvokeAbort | undefined>;
  afterInvoke?(args: AfterInvokeArgs): void | Promise<void>;
  onError?(args: OnErrorArgs): ErrorDisposition | undefined | Promise<ErrorDisposition | undefined>;
  onRecordError?(args: RecordErrorArgs): 'retry' | 'drop' | Promise<'retry' | 'drop'>;
  onShutdown?(ctx: SlingshotContext): void | Promise<void>;
}

/** Arguments passed to the `beforeInvoke` hook with the decoded input, handler meta, trigger name, cold-start flag, and context. */
export interface BeforeInvokeArgs {
  input: unknown;
  meta: HandlerMeta;
  trigger: string;
  isColdStart: boolean;
  ctx: SlingshotContext;
}

/** Arguments passed to the `afterInvoke` hook, extending {@link BeforeInvokeArgs} with the handler's output, error, and latency. */
export interface AfterInvokeArgs extends BeforeInvokeArgs {
  output?: unknown;
  error?: Error;
  latencyMs: number;
}

/** Classifies where in the invocation pipeline an error originated (validation, handler, timeout, infrastructure, etc.). */
export type ErrorKind =
  | 'validation'
  | 'handler'
  | 'timeout'
  | 'infrastructure'
  | 'bootstrap'
  | 'idempotency'
  | 'unknown';

/** Arguments passed to the `onError` hook describing a failed invocation, including the error, its {@link ErrorKind}, and correlation metadata. */
export interface OnErrorArgs {
  error: Error;
  kind: ErrorKind;
  input: unknown | null;
  meta: Record<string, unknown>;
  trigger: string;
  correlationId: string;
  isColdStart: boolean;
  ctx: SlingshotContext | null;
}

/** Value returned from `onError` that overrides how an invocation failure is reported (replacement error, status, body, or suppression). */
export interface ErrorDisposition {
  replaceWith?: Error;
  status?: number;
  body?: unknown;
  suppress?: boolean;
}

/** Arguments passed to the `onRecordError` hook when a single record within a batch trigger fails. */
export interface RecordErrorArgs {
  record: TriggerRecord;
  error: Error;
  trigger: string;
  ctx: SlingshotContext;
}

/** Returned from `beforeInvoke` to short-circuit an invocation, optionally supplying the response to return instead. */
export interface InvokeAbort {
  abort: true;
  response?: unknown;
}

/** Configuration for a functions runtime: the handler manifest, optional runtime, lifecycle hooks, and timeout budgets. */
export interface FunctionsRuntimeConfig {
  manifest: string | Record<string, unknown>;
  runtime?: SlingshotRuntime;
  hooks?: FunctionsHooks;
  handlersPath?: string | { dir: string } | false;
  /**
   * Maximum time in milliseconds the runtime waits for `onShutdown` to complete
   * when a SIGTERM signal is received.
   *
   * If `onShutdown` does not resolve within this window the shutdown proceeds
   * regardless. Defaults to `1500` ms.
   *
   * Only honoured by trigger-wrapper runtimes (e.g. serverless function hosts).
   */
  shutdownTimeoutMs?: number;
  /**
   * Maximum time in milliseconds a single record handler invocation may run.
   *
   * If the handler does not resolve within this window the runtime rejects with
   * a `HandlerError(code: 'handler-timeout', status: 504)` so observability and
   * retry policy treat it consistently with other failures. Without this, a hung
   * handler runs until the platform-level timeout (e.g. Lambda's 15 minute hard
   * cap) and consumes the full execution budget.
   *
   * When omitted the runtime imposes no timeout — the underlying platform
   * timeout still applies.
   *
   * Only honoured by trigger-wrapper runtimes (e.g. serverless function hosts).
   */
  handlerTimeoutMs?: number;
}

/** Idempotency settings for a wrapped trigger: dedup TTL, key scope, custom key derivation, and payload fingerprinting. */
export interface IdempotencyOpts {
  ttl?: number;
  scope?: 'global' | 'tenant' | 'user';
  key?: (record: TriggerRecord) => string | null;
  fingerprint?: boolean;
}

/** Per-trigger wrapping options, such as enabling or configuring {@link IdempotencyOpts}. */
export interface TriggerOpts {
  idempotency?: boolean | IdempotencyOpts;
}

/** A functions runtime that wraps handlers into trigger-platform entrypoints and exposes the context and shutdown lifecycle. */
export interface FunctionsRuntime {
  wrap(
    handler: SlingshotHandler,
    adapter: TriggerAdapter,
    opts?: TriggerOpts,
  ): (...args: unknown[]) => Promise<unknown>;
  getContext(): Promise<SlingshotContext>;
  shutdown(): Promise<void>;
}
