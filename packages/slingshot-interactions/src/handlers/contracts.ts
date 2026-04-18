import type { MessageKind } from '../components/types';
import type { DispatchRequest, DispatchResult } from '../routes/dispatchRoute.schema';
import type { HandlerTemplate } from './template';

/** Normalized payload passed to one compiled dispatcher. */
export interface DispatcherPayload {
  actionId: string;
  messageKind: MessageKind;
  messageId: string;
  userId: string;
  tenantId: string;
  values?: DispatchRequest['values'];
}

/** Dispatcher contract implemented by webhook, route, and queue handlers. */
export interface Dispatcher {
  dispatch(payload: DispatcherPayload): Promise<DispatchResult>;
}

/** One compiled handler entry after template resolution. */
export interface CompiledHandlerEntry {
  readonly prefix: string;
  readonly template: HandlerTemplate;
  readonly dispatcher: Dispatcher;
}

/** Runtime table used to resolve action IDs by longest matching prefix. */
export interface CompiledHandlerTable {
  readonly byPrefix: Readonly<Record<string, CompiledHandlerEntry>>;
  readonly sortedKeys: readonly string[];
  resolve(actionId: string): CompiledHandlerEntry | null;
}
