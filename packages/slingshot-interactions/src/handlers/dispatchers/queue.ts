import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { dispatchResultSchema } from '../../routes/dispatchRoute.schema';
import type { Dispatcher } from '../contracts';
import type { QueueHandlerTemplate } from '../template';

type DynamicBus = {
  emit(event: string, payload: unknown): void;
};

export function createQueueDispatcher(
  template: QueueHandlerTemplate,
  bus: SlingshotEventBus,
): Dispatcher {
  const dynamicBus = bus as DynamicBus;

  return {
    dispatch(payload) {
      dynamicBus.emit(template.target, payload);
      return Promise.resolve(
        dispatchResultSchema.parse(
          template.fireAndForget ? { status: 'ok' } : { status: 'ok', body: payload },
        ),
      );
    },
  };
}
