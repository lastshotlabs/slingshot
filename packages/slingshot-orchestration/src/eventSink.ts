import {
  type SlingshotEventBus,
  type SlingshotEventMap,
  createConsoleLogger,
} from '@lastshotlabs/slingshot-core';
import type { OrchestrationEventSink } from '@lastshotlabs/slingshot-orchestration-engine';

const loggerErr = createConsoleLogger({ base: { component: 'slingshot-orchestration' } });

/**
 * Disposable orchestration event sink that bridges the orchestration runtime onto
 * Slingshot's event bus. The plugin teardown phase MUST call `dispose()` so any
 * subscriptions registered against the bus by this sink (or future helpers
 * sharing this contract) do not accumulate across plugin reloads.
 */
export interface SlingshotEventSink extends OrchestrationEventSink {
  /**
   * Drop every subscription this sink has registered on the underlying bus. Safe
   * to call more than once. After `dispose()` the sink keeps emitting (callers
   * can race teardown with in-flight task callbacks) but will not register new
   * subscriptions.
   */
  dispose(): void;
  /**
   * Register an event-bus listener whose lifetime is tied to this sink. The
   * returned handle removes the listener immediately when called; `dispose()`
   * removes it as part of bulk cleanup.
   */
  subscribe<K extends keyof SlingshotEventMap>(
    event: K,
    handler: (payload: SlingshotEventMap[K]) => void | Promise<void>,
  ): () => void;
  subscribe(event: string, handler: (payload: unknown) => void | Promise<void>): () => void;
}

/**
 * Adapt orchestration lifecycle events onto Slingshot's event bus.
 *
 * Errors thrown by the bus are caught and logged so that a broken or misconfigured
 * event bus never disrupts orchestration task execution. The returned sink owns
 * any subscriptions registered through `subscribe()` and provides `dispose()` so
 * the plugin teardown can release them.
 */
export function createSlingshotEventSink(bus: SlingshotEventBus): SlingshotEventSink {
  const unsubs = new Set<() => void>();
  let disposed = false;

  function subscribe<K extends keyof SlingshotEventMap>(
    event: K,
    handler: (payload: SlingshotEventMap[K]) => void | Promise<void>,
  ): () => void;
  function subscribe(
    event: string,
    handler: (payload: unknown) => void | Promise<void>,
  ): () => void;
  function subscribe(event: string, handler: (payload: never) => void | Promise<void>): () => void {
    if (disposed) {
      return () => {
        /* no-op */
      };
    }
    const untypedHandler = handler as (payload: unknown) => void | Promise<void>;
    bus.on(event, untypedHandler);
    const unsubscribe = () => {
      try {
        if (
          typeof (bus as unknown as { off?: (e: string, h: unknown) => void }).off === 'function'
        ) {
          (bus as unknown as { off: (e: string, h: unknown) => void }).off(event, untypedHandler);
        }
      } catch (err) {
        loggerErr.error('eventSink.unsubscribe error', { err: String(err) });
      }
      unsubs.delete(unsubscribe);
    };
    unsubs.add(unsubscribe);
    return unsubscribe;
  }

  return {
    emit(name, payload) {
      try {
        bus.emit(name, payload);
      } catch (err) {
        loggerErr.error('eventSink.emit error', { err: String(err) });
      }
    },
    subscribe,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of [...unsubs]) {
        try {
          unsubscribe();
        } catch (err) {
          loggerErr.error('eventSink.dispose error', { err: String(err) });
        }
      }
      unsubs.clear();
    },
  };
}
