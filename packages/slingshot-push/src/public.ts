/**
 * Public contract for `slingshot-push`.
 *
 * Cross-package consumers (notably `slingshot-chat` for formatter registration) resolve
 * `PushRuntimeCap` through `ctx.capabilities.require(...)`.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { NotificationRecord } from '@lastshotlabs/slingshot-core';
import type { PushPluginState } from './state';
import type { PushProviderHealth } from './providers/provider';
import type { PushMessage } from './types/models';

/**
 * Minimum surface peer plugins (community, chat) need from the push runtime
 * to install per-source formatters. Intentionally narrower than the full
 * `PushPluginState` so consumers don't pull in router / providers.
 */
export interface PushFormatterRegistry {
  /** Register or replace a runtime formatter for one notification type. */
  registerFormatter(
    type: string,
    formatter: (
      notification: NotificationRecord,
      defaults?: Partial<PushMessage>,
    ) => PushMessage,
  ): void;
}

/** Provider-owned package contract for `slingshot-push`. */
export const Push = definePackageContract('slingshot-push');

/**
 * Capability handle for the push notifications runtime.
 *
 * Cross-package consumers (notably `slingshot-chat` for formatter registration) resolve
 * it through `ctx.capabilities.require(PushRuntimeCap)`.
 */
export const PushRuntimeCap = Push.capability<PushPluginState>('runtime');

/**
 * Aggregated health snapshot for `slingshot-push`.
 *
 * `status` is derived from the underlying signals:
 *   - `'unhealthy'` when any provider's circuit breaker is `open`, or when the
 *     router-level breaker is `open`.
 *   - `'degraded'` when any provider's circuit is `half-open`, any provider
 *     has accumulated `consecutiveFailures > 0`, or the router-level breaker
 *     is `half-open`.
 *   - `'healthy'` otherwise.
 */
export interface PushPluginHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly details: {
    readonly providers: Readonly<
      Partial<Record<'web' | 'ios' | 'android', PushProviderHealth | null>>
    >;
    readonly routerCircuitBreaker?: {
      readonly state: 'closed' | 'open' | 'half-open';
      readonly consecutiveFailures: number;
    };
  };
}

/**
 * Capability for reading the aggregated push health snapshot.
 *
 * Consumers resolve via `ctx.capabilities.require(PushHealthCap)()` and
 * receive a `PushPluginHealth` representing provider and router state at call
 * time.
 */
export const PushHealthCap = Push.capability<() => PushPluginHealth>('health');

/**
 * Capability handle for the push formatter registry.
 *
 * Cross-package consumers (notably `slingshot-chat` and `slingshot-community`
 * during their setupPost hooks) resolve it via
 * `ctx.capabilities.require(PushFormatterRegistryCap)` to install per-source
 * formatters without reaching into push's full runtime state.
 */
export const PushFormatterRegistryCap =
  Push.capability<PushFormatterRegistry>('formatterRegistry');
