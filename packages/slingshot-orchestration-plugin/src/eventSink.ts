import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { OrchestrationEventSink } from '@lastshotlabs/slingshot-orchestration';

/**
 * Adapt orchestration lifecycle events onto Slingshot's event bus.
 *
 * Errors thrown by the bus are caught and logged so that a broken or misconfigured
 * event bus never disrupts orchestration task execution.
 */
export function createSlingshotEventSink(bus: SlingshotEventBus): OrchestrationEventSink {
  return {
    emit(name, payload) {
      try {
        bus.emit(name, payload);
      } catch (err) {
        console.error('[slingshot-orchestration] eventSink.emit error:', err);
      }
    },
  };
}
