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

    let cleanupCalled = false;
    let createdHandler: ((payload: unknown) => void) | undefined;
    let updatedHandler: ((payload: unknown) => void) | undefined;

    const cleanup = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      if (createdHandler) {
        bus.off('notifications:notification.created', createdHandler);
      }
      if (updatedHandler) {
        bus.off('notifications:notification.updated', updatedHandler);
      }
    };

    const stream = new ReadableStream<string>({
      start(controller) {
        if (c.req.raw.signal.aborted) {
          cleanup();
          controller.close();
          return;
        }
        writeSseChunk(controller, 'retry: 5000');
        writeSseChunk(controller, ': connected');

        createdHandler = (payload: unknown) => {
          const event = payload as NotificationCreatedEventPayload;
          if (event.notification.userId !== userId) return;
          writeSseChunk(controller, 'event: notification.created');
          writeSseChunk(controller, `data: ${JSON.stringify(event)}`);
        };

        updatedHandler = (payload: unknown) => {
          const event = payload as { userId?: string };
          if (event.userId !== userId) return;
          writeSseChunk(controller, 'event: notification.updated');
          writeSseChunk(controller, `data: ${JSON.stringify(payload)}`);
        };

        bus.on('notifications:notification.created', createdHandler);
        bus.on('notifications:notification.updated', updatedHandler);

        const closeAndCleanup = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // ignore: controller may already be closed if the stream errored
          }
        };

        c.req.raw.signal.addEventListener('abort', closeAndCleanup, { once: true });

        // Also clean up if the underlying Node.js stream errors (e.g. client
        // disconnects before the abort signal fires). Web Streams'
        // ReadableStreamDefaultController has no `on()`; this duck-types the
        // Node-stream extension some runtimes expose so we can attach error
        // listeners without breaking standards-conformant runtimes.
        const nodeStyleController = controller as unknown as {
          on?: (event: string, fn: () => void) => void;
        };
        nodeStyleController.on?.('error', closeAndCleanup);
      },
      cancel() {
        // Ensure bus listeners are removed when the consumer cancels the stream.
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
