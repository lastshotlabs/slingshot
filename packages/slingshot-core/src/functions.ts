import type { SlingshotContext } from './context/slingshotContext';
import type { HandlerMeta, SlingshotHandler } from './handler';
import type { Actor } from './identity';
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
 * runtime uses to construct the canonical {@link Actor}. Trigger adapters
 * can either set the `actor` field directly or provide the raw identity
 * fields and let `buildMeta` derive the actor.
 */
export interface TriggerExtractedMeta extends Partial<HandlerMeta> {
  /** Tenant context from the trigger event metadata. */
  tenantId?: string | null;
  /** User ID from the trigger event metadata. */
  authUserId?: string | null;
  /** M2M client ID from the trigger event metadata. */
  authClientId?: string | null;
  /** Bearer client ID from the trigger event metadata. */
  bearerClientId?: string | null;
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

export interface BeforeInvokeArgs {
  input: unknown;
  meta: HandlerMeta;
  trigger: string;
  isColdStart: boolean;
  ctx: SlingshotContext;
}

export interface AfterInvokeArgs extends BeforeInvokeArgs {
  output?: unknown;
  error?: Error;
  latencyMs: number;
}

export type ErrorKind =
  | 'validation'
  | 'handler'
  | 'timeout'
  | 'infrastructure'
  | 'bootstrap'
  | 'idempotency'
  | 'unknown';

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

export interface ErrorDisposition {
  replaceWith?: Error;
  status?: number;
  body?: unknown;
  suppress?: boolean;
}

export interface RecordErrorArgs {
  record: TriggerRecord;
  error: Error;
  trigger: string;
  ctx: SlingshotContext;
}

export interface InvokeAbort {
  abort: true;
  response?: unknown;
}

export interface FunctionsRuntimeConfig {
  manifest: string | Record<string, unknown>;
  runtime?: SlingshotRuntime;
  hooks?: FunctionsHooks;
  handlersPath?: string | { dir: string } | false;
}

export interface IdempotencyOpts {
  ttl?: number;
  scope?: 'global' | 'tenant' | 'user';
  key?: (record: TriggerRecord) => string | null;
  fingerprint?: boolean;
}

export interface TriggerOpts {
  idempotency?: boolean | IdempotencyOpts;
}

export interface FunctionsRuntime {
  wrap(
    handler: SlingshotHandler,
    adapter: TriggerAdapter,
    opts?: TriggerOpts,
  ): (...args: unknown[]) => Promise<unknown>;
  getContext(): Promise<SlingshotContext>;
  shutdown(): Promise<void>;
}
