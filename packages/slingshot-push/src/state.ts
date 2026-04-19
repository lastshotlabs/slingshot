import type { DeliveryAdapter, NotificationRecord } from '@lastshotlabs/slingshot-core';
import { PUSH_PLUGIN_STATE_KEY as CORE_PUSH_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';
import type { PushProvider } from './providers/provider';
import type { PushRouter } from './router';
import type { PushFormatterFn, PushFormatterTemplate, PushPluginConfig } from './types/config';
import type { PushMessage } from './types/models';

/** Stable plugin-state key used in `ctx.pluginState`. */
export const PUSH_PLUGIN_STATE_KEY = CORE_PUSH_PLUGIN_STATE_KEY;

/** Compiled formatter registry used by the push delivery adapter. */
export interface CompiledPushFormatterTable {
  /** Declarative formatter templates keyed by notification type. */
  readonly templates: Readonly<Partial<Record<string, PushFormatterTemplate>>>;
  /** Resolve a formatter for a notification type or return `null`. */
  resolve(type: string): PushFormatterFn | null;
  /** Register or replace a runtime formatter escape hatch. */
  register(type: string, formatter: PushFormatterFn): void;
  /** Format a notification into a normalized push payload. */
  format(notification: NotificationRecord, defaults?: Partial<PushMessage>): PushMessage;
}

/** Runtime state published by `createPushPlugin()`. */
export interface PushPluginState {
  /** Deep-frozen plugin config. */
  readonly config: Readonly<PushPluginConfig>;
  /** Router responsible for user and topic fan-out. */
  readonly router: PushRouter;
  /** Provider instances for the enabled platforms. */
  readonly providers: Readonly<Partial<Record<'web' | 'ios' | 'android', PushProvider>>>;
  /** Declarative and runtime formatter table. */
  readonly formatters: CompiledPushFormatterTable;
  /** Register a runtime formatter override for one notification type. */
  registerFormatter(type: string, formatter: PushFormatterFn): void;
  /** Create a notifications delivery adapter backed by the push router. */
  createDeliveryAdapter(opts?: { skipSources?: string[] }): DeliveryAdapter;
}
