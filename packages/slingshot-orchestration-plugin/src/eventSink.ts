import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { OrchestrationEventSink } from '@lastshotlabs/slingshot-orchestration';

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
  subscribe<K extends Parameters<SlingshotEventBus['on']>[0]>(
    event: K,
    handler: Parameters<SlingshotEventBus['on']>[1],
  ): () => void;
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

  return {
    emit(name, payload) {
      try {
        bus.emit(name, payload);
      } catch (err) {
        console.error('[slingshot-orchestration] eventSink.emit error:', err);
      }
    },
    subscribe(event, handler) {
      if (disposed) {
        return () => {
          /* no-op */
        };
      }
      bus.on(event, handler);
      const unsubscribe = () => {
        try {
          if (typeof (bus as unknown as { off?: (e: string, h: unknown) => void }).off === 'function') {
            (bus as unknown as { off: (e: string, h: unknown) => void }).off(event, handler);
          }
        } catch (err) {
          console.error('[slingshot-orchestration] eventSink.unsubscribe error:', err);
        }
        unsubs.delete(unsubscribe);
      };
      unsubs.add(unsubscribe);
      return unsubscribe;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of [...unsubs]) {
        try {
          unsubscribe();
        } catch (err) {
          console.error('[slingshot-orchestration] eventSink.dispose error:', err);
        }
      }
      unsubs.clear();
    },
  };
}
