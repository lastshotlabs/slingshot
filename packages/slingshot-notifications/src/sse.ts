import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { createRouter, getActorId } from '@lastshotlabs/slingshot-core';
import type { NotificationCreatedEventPayload } from './types';

type DynamicBus = {
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
};

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
  const dynamicBus = bus as unknown as DynamicBus;

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
        dynamicBus.off('notifications:notification.created', createdHandler);
      }
      if (updatedHandler) {
        dynamicBus.off('notifications:notification.updated', updatedHandler);
      }
    };

    const stream = new ReadableStream<string>({
      start(controller) {
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

        dynamicBus.on('notifications:notification.created', createdHandler);
        dynamicBus.on('notifications:notification.updated', updatedHandler);

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
        // disconnects before the abort signal fires).
        (controller as unknown as { on?: (event: string, fn: () => void) => void }).on?.(
          'error',
          closeAndCleanup,
        );
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
