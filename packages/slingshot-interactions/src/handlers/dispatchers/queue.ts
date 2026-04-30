import type { DynamicEventBus, SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { dispatchResultSchema } from '../../routes/dispatchRoute.schema';
import type { Dispatcher } from '../contracts';
import type { QueueHandlerTemplate } from '../template';

function isDynamicBus(bus: SlingshotEventBus): bus is SlingshotEventBus & DynamicEventBus {
  return typeof (bus as DynamicEventBus).emit === 'function';
}

export function createQueueDispatcher(
  template: QueueHandlerTemplate,
  bus: SlingshotEventBus,
): Dispatcher {
  if (!isDynamicBus(bus)) {
    throw new TypeError('[slingshot-interactions] Event bus does not support dynamic emit');
  }
  const dynamicBus = bus;

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
