import type {
  PermissionsState,
  RateLimitAdapter,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import type { CompiledHandlerTable, Dispatcher } from './handlers/contracts';
import type { ChatInteractionsPeer, CommunityInteractionsPeer } from './peers/types';

/** Stable plugin-state key used in `ctx.pluginState`. */
export const INTERACTIONS_PLUGIN_STATE_KEY = 'slingshot-interactions' as const;

/** Runtime state published by `createInteractionsPlugin()`. */
export interface InteractionsPluginState {
  /** Compiled declarative handlers plus any runtime overlays. */
  readonly handlers: CompiledHandlerTable;
  /** Shared rate-limit adapter used for per-user dispatch throttling. */
  readonly rateLimit: RateLimitAdapter;
  /** Permissions plugin state used for dispatch authorization. */
  readonly permissions: PermissionsState;
  /** Event bus captured during setup. */
  readonly bus: SlingshotEventBus;
  /** Rate-limit window for the dispatch endpoint. */
  readonly rateLimitWindowMs: number;
  /** Maximum dispatches allowed in the active window. */
  readonly rateLimitMax: number;
  /** Optional chat/community peers used to resolve and mutate message owners. */
  readonly peers: {
    readonly chat: ChatInteractionsPeer | null;
    readonly community: CommunityInteractionsPeer | null;
  };
  /** Audit repositories resolved through the entity framework. */
  readonly repos: {
    interactionEvents: BareEntityAdapter | null;
  };
  /** Optional logger used for unreachable/shadowed handler warnings. */
  readonly logger?: {
    warn?(payload: unknown, message?: string): void;
    info?(payload: unknown, message?: string): void;
    debug?(payload: unknown, message?: string): void;
  } | null;
  /** Register a runtime dispatcher overlay for an action-id prefix. */
  registerHandler(prefix: string, dispatcher: Dispatcher): void;
}
