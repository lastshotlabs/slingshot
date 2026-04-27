import { OrchestrationError } from './errors';
import type {
  ObservabilityCapability,
  OrchestrationAdapter,
  OrchestrationCapability,
  ProgressCapability,
  RunHandle,
  ScheduleCapability,
  SignalCapability,
} from './types';

/**
 * Generate a sortable public orchestration run ID.
 *
 * The format is `run_` plus a Crockford-style timestamp/random suffix so adapters can
 * use the same externally-visible identifier even when the underlying engine keeps its
 * own internal job ID.
 */
export function generateRunId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let timestamp = Date.now();
  let encodedTime = '';
  for (let index = 0; index < 10; index += 1) {
    encodedTime = alphabet[timestamp % 32] + encodedTime;
    timestamp = Math.floor(timestamp / 32);
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let encodedRandom = '';
  for (let index = 0; index < 16; index += 1) {
    encodedRandom += alphabet[bytes[index] % 32];
  }

  return `run_${encodedTime}${encodedRandom}`;
}

/**
 * Wrap a lazy result loader in an idempotent `RunHandle`.
 */
export function createCachedRunHandle<TOutput>(
  id: string,
  loader: () => Promise<TOutput>,
): RunHandle<TOutput> {
  let cached: Promise<TOutput> | undefined;
  return {
    id,
    result() {
      if (!cached) {
        cached = loader();
      }
      return cached;
    },
  };
}

/**
 * Check whether an adapter exposes an optional orchestration capability.
 */
export function supportsCapability(
  adapter: OrchestrationAdapter,
  capability: OrchestrationCapability,
): boolean {
  switch (capability) {
    case 'signals':
      return typeof (adapter as SignalCapability).signal === 'function';
    case 'scheduling':
      return typeof (adapter as ScheduleCapability).schedule === 'function';
    case 'observability':
      return typeof (adapter as ObservabilityCapability).listRuns === 'function';
    case 'progress':
      return typeof (adapter as ProgressCapability).onProgress === 'function';
  }
}

/**
 * Throw the standardized error for an unsupported optional capability.
 *
 * Signals and scheduling are not implemented in the memory or SQLite adapters.
 * Use the slingshot-orchestration-temporal adapter for signal and scheduling support.
 */
export function throwUnsupported(capability: OrchestrationCapability): never {
  const hint =
    capability === 'signals' || capability === 'scheduling'
      ? ' Not implemented in memory/sqlite adapters — use Temporal adapter for signal support.'
      : '';
  throw new OrchestrationError(
    'CAPABILITY_NOT_SUPPORTED',
    `Adapter does not support '${capability}'. Check runtime.supports('${capability}') before calling.${hint}`,
  );
}
