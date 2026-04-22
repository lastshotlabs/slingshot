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

    const stream = new ReadableStream<string>({
      start(controller) {
        writeSseChunk(controller, 'retry: 5000');
        writeSseChunk(controller, ': connected');

        const createdHandler = (payload: unknown) => {
          const event = payload as NotificationCreatedEventPayload;
          if (event.notification.userId !== userId) return;
          writeSseChunk(controller, 'event: notification.created');
          writeSseChunk(controller, `data: ${JSON.stringify(event)}`);
        };

        const updatedHandler = (payload: unknown) => {
          const event = payload as { userId?: string };
          if (event.userId !== userId) return;
          writeSseChunk(controller, 'event: notification.updated');
          writeSseChunk(controller, `data: ${JSON.stringify(payload)}`);
        };

        dynamicBus.on('notifications:notification.created', createdHandler);
        dynamicBus.on('notifications:notification.updated', updatedHandler);

        const cleanup = () => {
          dynamicBus.off('notifications:notification.created', createdHandler);
          dynamicBus.off('notifications:notification.updated', updatedHandler);
          controller.close();
        };

        c.req.raw.signal.addEventListener('abort', cleanup, { once: true });
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
