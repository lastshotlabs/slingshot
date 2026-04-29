import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { createRouter, getActorId } from '@lastshotlabs/slingshot-core';
import type { NotificationCreatedEventPayload } from './types';

function writeSseChunk(controller: ReadableStreamDefaultController<string>, data: string): void {
  controller.enqueue(`${data}\n\n`);
}

/**
 * Create the built-in notifications SSE route.
 *
 * @param bus - App event bus.
 * @param path - Route path to mount.
 * @returns Router serving the SSE endpoint.
 */
export function createNotificationSseRoute(bus: SlingshotEventBus, path: string) {
  const router = createRouter();

  router.get(path, c => {
    const userId = getActorId(c);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // P-NOTIF-5: SSE cleanup must be idempotent and registered on every
    // termination path — abort signal, controller error, controller cancel,
    // and (for Node-style streams) the underlying socket's `error` event.
    // The handlers are declared at outer scope so `cancel()` can always
    // detach them even if `start()` did not finish wiring (e.g. because
    // the request was aborted before bus.on returned).
    let cleanedUp = false;
    let createdHandler: ((payload: unknown) => void) | undefined;
    let updatedHandler: ((payload: unknown) => void) | undefined;
    let abortListener: (() => void) | undefined;
    let abortSignal: AbortSignal | undefined;

    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (createdHandler) {
        try {
          bus.off('notifications:notification.created', createdHandler);
        } catch {
          // never throw from cleanup
        }
        createdHandler = undefined;
      }
      if (updatedHandler) {
        try {
          bus.off('notifications:notification.updated', updatedHandler);
        } catch {
          // never throw from cleanup
        }
        updatedHandler = undefined;
      }
      if (abortSignal && abortListener) {
        try {
          abortSignal.removeEventListener('abort', abortListener);
        } catch {
          // never throw from cleanup
        }
        abortListener = undefined;
      }
    };

    const stream = new ReadableStream<string>({
      start(controller) {
        const closeAndCleanup = (): void => {
          cleanup();
          try {
            controller.close();
          } catch {
            // ignore: controller may already be closed if the stream errored
          }
        };

        if (c.req.raw.signal.aborted) {
          closeAndCleanup();
          return;
        }

        // Wire bus listeners FIRST so we can guarantee cleanup() can detach
        // them no matter which termination path fires next.
        createdHandler = (payload: unknown) => {
          const event = payload as NotificationCreatedEventPayload;
          if (event.notification.userId !== userId) return;
          try {
            writeSseChunk(controller, 'event: notification.created');
            writeSseChunk(controller, `data: ${JSON.stringify(event)}`);
          } catch {
            // Stream is gone — fall through to cleanup so we don't leak.
            closeAndCleanup();
          }
        };
        updatedHandler = (payload: unknown) => {
          const event = payload as { userId?: string };
          if (event.userId !== userId) return;
          try {
            writeSseChunk(controller, 'event: notification.updated');
            writeSseChunk(controller, `data: ${JSON.stringify(payload)}`);
          } catch {
            closeAndCleanup();
          }
        };
        bus.on('notifications:notification.created', createdHandler);
        bus.on('notifications:notification.updated', updatedHandler);

        try {
          writeSseChunk(controller, 'retry: 5000');
          writeSseChunk(controller, ': connected');
        } catch {
          closeAndCleanup();
          return;
        }

        abortSignal = c.req.raw.signal;
        abortListener = closeAndCleanup;
        abortSignal.addEventListener('abort', abortListener, { once: true });

        // Also clean up if the underlying Node.js stream errors (e.g. client
        // disconnects before the abort signal fires). Web Streams'
        // ReadableStreamDefaultController has no `on()`; this duck-types the
        // Node-stream extension some runtimes expose so we can attach error
        // listeners without breaking standards-conformant runtimes.
        const nodeStyleController = controller as unknown as {
          on?: (event: string, fn: () => void) => void;
        };
        nodeStyleController.on?.('error', closeAndCleanup);
        nodeStyleController.on?.('close', closeAndCleanup);
      },
      cancel() {
        // Ensure bus listeners are removed when the consumer cancels the
        // stream — even if `start()` only partially wired itself before
        // throwing.
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  return router;
}
