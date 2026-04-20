import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { OrchestrationEventSink } from '@lastshotlabs/slingshot-orchestration';

/**
 * Adapt orchestration lifecycle events onto Slingshot's event bus.
 */
export function createSlingshotEventSink(bus: SlingshotEventBus): OrchestrationEventSink {
  return {
    emit(name, payload) {
      bus.emit(name, payload);
    },
  };
}
